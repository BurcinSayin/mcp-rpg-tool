/**
 * Tests for the outbound path.
 *
 * This module had none, which meant every *stateful* thing in the codebase was
 * unexercised: the throttle, the concurrency gate, 429 escalation and decay,
 * abort and timeout, and the capped reader. The pure-function suites were healthy
 * while the parts that can actually deadlock, drift or breach a ceiling were not.
 *
 * The injectable clock and sleep are what make this deterministic — a throttle
 * tested with real timers is a slow test that still cannot prove ordering.
 */

import { describe, expect, it, vi } from 'vitest';
import { Deadline, HttpClient } from '../../src/http.js';
import { BackendError } from '../../src/provider/types.js';
import {
  MAX_CONCURRENT_REQUESTS,
  MAX_RESPONSE_BYTES,
  THROTTLE_MIN_INTERVAL_MS,
  USER_AGENT,
} from '../../src/constants.js';

/** A virtual clock: time advances only when the code under test sleeps. */
function fakeClock() {
  let now = 1_000;
  return {
    now: () => now,
    sleep: (ms: number): Promise<void> => {
      now += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('identification', () => {
  it('sends the identifying User-Agent on every request', async () => {
    const seen: string[] = [];
    const client = new HttpClient({
      ...fakeClock(),
      fetchImpl: ((_url: string, init: RequestInit) => {
        seen.push((init.headers as Record<string, string>)['user-agent'] ?? '');
        return Promise.resolve(jsonResponse({ ok: true }));
      }) as unknown as typeof fetch,
    });

    await client.requestJson({ url: 'https://example.test/a' });
    await client.requestJson({ url: 'https://example.test/b' });

    expect(seen).toEqual([USER_AGENT, USER_AGENT]);
  });
});

describe('throttle', () => {
  it('spaces sequential requests by at least the minimum interval', async () => {
    const clock = fakeClock();
    const starts: number[] = [];
    const client = new HttpClient({
      ...clock,
      fetchImpl: (() => {
        starts.push(clock.now());
        return Promise.resolve(jsonResponse({}));
      }) as unknown as typeof fetch,
    });

    await client.requestJson({ url: 'https://example.test/1' });
    await client.requestJson({ url: 'https://example.test/2' });
    await client.requestJson({ url: 'https://example.test/3' });

    expect(starts).toHaveLength(3);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(THROTTLE_MIN_INTERVAL_MS);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(THROTTLE_MIN_INTERVAL_MS);
  });

  /**
   * The ceiling is a promise to infrastructure we do not own, so it has to hold
   * under concurrency rather than only when calls arrive one at a time.
   *
   * Releasing a slot and letting the woken waiter re-take it a microtask later
   * leaves a window where a newly arriving caller passes the capacity check and
   * takes it first — briefly running three against a ceiling of two.
   */
  it('never exceeds the concurrency ceiling, including while callers are queued', async () => {
    const clock = fakeClock();
    let inFlight = 0;
    let peak = 0;

    const client = new HttpClient({
      ...clock,
      fetchImpl: (async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        // Yield across several microtask turns so a slot frees while other
        // callers are actively queued — the window where a released-then-
        // reclaimed slot would let a third caller barge in.
        for (let i = 0; i < 4; i += 1) await Promise.resolve();
        inFlight -= 1;
        return jsonResponse({});
      }) as unknown as typeof fetch,
    });

    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        client.requestJson({ url: `https://example.test/${i}` }),
      ),
    );

    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_REQUESTS);
    expect(client.requestCount).toBe(12);
  });

  it('lengthens the interval after a 429 and decays it back on success', async () => {
    const clock = fakeClock();
    let first = true;
    const client = new HttpClient({
      ...clock,
      fetchImpl: (() => {
        if (first) {
          first = false;
          return Promise.resolve(new Response('slow down', { status: 429 }));
        }
        return Promise.resolve(jsonResponse({}));
      }) as unknown as typeof fetch,
    });

    await expect(client.requestJson({ url: 'https://example.test/x' })).rejects.toThrow(
      BackendError,
    );
    const escalated = client.currentIntervalMs;
    expect(escalated).toBeGreaterThan(THROTTLE_MIN_INTERVAL_MS);

    // No retry of the failed request — a 429 surfaces as an error, and only
    // subsequent traffic is slowed.
    for (let i = 0; i < 5; i += 1) {
      await client.requestJson({ url: `https://example.test/ok${i}` });
    }
    expect(client.currentIntervalMs).toBeLessThan(escalated);
    expect(client.currentIntervalMs).toBeGreaterThanOrEqual(THROTTLE_MIN_INTERVAL_MS);
  });
});

describe('failures', () => {
  it('reports an upstream error status as upstream', async () => {
    const client = new HttpClient({
      ...fakeClock(),
      fetchImpl: (() =>
        Promise.resolve(new Response('boom', { status: 503 }))) as unknown as typeof fetch,
    });

    await expect(client.requestJson({ url: 'https://example.test/x' })).rejects.toMatchObject({
      status: 503,
      fromUpstream: true,
    });
  });

  /**
   * A locally-determined failure must not be dressed up as an upstream status:
   * the response arrived perfectly well and this client rejected its size.
   */
  it('does not attribute an oversized body to upstream', async () => {
    const client = new HttpClient({
      ...fakeClock(),
      fetchImpl: (() =>
        Promise.resolve(
          new Response('{}', {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'content-length': String(MAX_RESPONSE_BYTES + 1),
            },
          }),
        )) as unknown as typeof fetch,
    });

    await expect(client.requestJson({ url: 'https://example.test/big' })).rejects.toMatchObject({
      detail: 'oversized',
      status: undefined,
      fromUpstream: false,
    });
  });

  it('caps a body that understates its own length', async () => {
    const huge = 'x'.repeat(1024);
    const client = new HttpClient({
      ...fakeClock(),
      fetchImpl: (() => {
        // No content-length: the stream must be counted as it is consumed.
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (let i = 0; i < (MAX_RESPONSE_BYTES / 1024) + 2; i += 1) {
              controller.enqueue(new TextEncoder().encode(huge));
            }
            controller.close();
          },
        });
        return Promise.resolve(new Response(stream, { status: 200 }));
      }) as unknown as typeof fetch,
    });

    await expect(client.requestJson({ url: 'https://example.test/stream' })).rejects.toMatchObject({
      detail: 'oversized',
    });
  });

  it('surfaces a network failure without leaking the underlying message', async () => {
    const client = new HttpClient({
      ...fakeClock(),
      fetchImpl: (() =>
        Promise.reject(
          new Error('connect ECONNREFUSED 10.0.0.5:443'),
        )) as unknown as typeof fetch,
    });

    const error: BackendError = await client
      .requestJson({ url: 'https://example.test/x' })
      .then(() => {
        throw new Error('expected the request to fail');
      })
      .catch((e: unknown) => e as BackendError);

    expect(error).toBeInstanceOf(BackendError);
    // Node names hosts, ports and resolvers; those describe the local environment
    // and belong in stderr, not in a result the caller reads.
    expect(error.message).not.toContain('10.0.0.5');
    expect(error.detail).toBe('network');
  });

  /**
   * Attaching a listener to a signal that has ALREADY aborted never fires, so a
   * call which expired while queued behind the throttle would otherwise still be
   * sent — spending a request on work whose deadline has passed.
   */
  it('refuses to send a request whose deadline expired while it waited', async () => {
    let called = false;
    const client = new HttpClient({
      ...fakeClock(),
      fetchImpl: (() => {
        called = true;
        return Promise.resolve(jsonResponse({}));
      }) as unknown as typeof fetch,
    });

    const controller = new AbortController();
    controller.abort();

    await expect(
      client.requestJson({ url: 'https://example.test/x', signal: controller.signal }),
    ).rejects.toMatchObject({ detail: 'timeout' });
    expect(called).toBe(false);
  });
});

describe('request accounting', () => {
  it('counts requests, so a cache hit can be proven to make none', async () => {
    const client = new HttpClient({
      ...fakeClock(),
      fetchImpl: (() => Promise.resolve(jsonResponse({}))) as unknown as typeof fetch,
    });

    expect(client.requestCount).toBe(0);
    await client.requestJson({ url: 'https://example.test/1' });
    await client.requestJson({ url: 'https://example.test/2' });
    expect(client.requestCount).toBe(2);
  });
});

describe('Deadline', () => {
  it('reports the remaining budget and floors at zero', () => {
    const clock = fakeClock();
    const deadline = new Deadline(1_000, clock.now);

    expect(deadline.remainingMs()).toBe(1_000);
    clock.advance(400);
    expect(deadline.remainingMs()).toBe(600);
    clock.advance(5_000);
    expect(deadline.remainingMs()).toBe(0);
  });

  /**
   * The old form checked `aborted === false` at fifty seconds remaining, which is
   * true whether or not dispose does anything -- making `dispose` a no-op passed
   * cleanly. The property is that the timer is actually cleared, so this waits
   * past a deliberately short budget and checks the signal never fires.
   */
  it('clears the timer on dispose so the signal never fires', async () => {
    const deadline = new Deadline(20);
    const { signal, dispose } = deadline.abortSignal();
    dispose();

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(signal.aborted, 'dispose did not clear the timer').toBe(false);
  });

  it('fires when the budget elapses and dispose was not called', async () => {
    // Fake timers rather than a real 20ms budget against a 60ms wait. A 3x margin
    // is thin on a shared runner, and this was the only new test here with a
    // flakiness profile -- the rest of the file already drives time deterministically.
    vi.useFakeTimers();
    try {
      const deadline = new Deadline(20);
      const { signal } = deadline.abortSignal();

      expect(signal.aborted).toBe(false);
      vi.advanceTimersByTime(50);
      expect(signal.aborted, 'the deadline signal never fired').toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
