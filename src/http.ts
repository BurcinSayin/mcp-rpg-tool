/**
 * The single outbound HTTP path.
 *
 * Every request in the process goes through here, so identification, throttling
 * and timeout are properties of the system rather than per-call-site discipline.
 * Archives of Nethys is unowned community infrastructure with no published rate
 * limit; being a considerate client is a mechanism here, not an intention.
 *
 * Deliberately provider-agnostic -- lint forbids it importing from a concrete provider, though types are permitted.
 */

import process from 'node:process';
import {
  HTTP_REQUEST_BUDGET_MS,
  MAX_RESPONSE_BYTES,
  MAX_CONCURRENT_REQUESTS,
  THROTTLE_429_INTERVAL_MS,
  THROTTLE_DECAY_FACTOR,
  THROTTLE_MIN_INTERVAL_MS,
  USER_AGENT,
} from './constants.js';
import { BackendError } from './provider/types.js';

export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  /** Milliseconds. Callers pass their remaining tool-call budget so the deadline is shared, not per-hop. */
  budgetMs?: number;
  signal?: AbortSignal;
}

/** Test seam: lets the throttle be driven without real time passing. */
export interface HttpClientOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class HttpClient {
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #fetch: typeof fetch;

  /** Grows on 429, decays on success. Never below the floor. */
  #interval = THROTTLE_MIN_INTERVAL_MS;
  #lastStart = Number.NEGATIVE_INFINITY;
  #inFlight = 0;
  #queue: Array<() => void> = [];

  #requestCount = 0;

  constructor(options: HttpClientOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#sleep = options.sleep ?? defaultSleep;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  /** Total requests issued. Used by tests to prove cache hits make no second call. */
  get requestCount(): number {
    return this.#requestCount;
  }

  get currentIntervalMs(): number {
    return this.#interval;
  }

  async requestJson<T = unknown>(req: HttpRequest): Promise<T> {
    await this.#acquire();
    try {
      await this.#respectInterval();
      return await this.#send<T>(req);
    } finally {
      this.#release();
    }
  }

  async #send<T>(req: HttpRequest): Promise<T> {
    const budget = Math.min(req.budgetMs ?? HTTP_REQUEST_BUDGET_MS, HTTP_REQUEST_BUDGET_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, budget));

    // Checked before listening: attaching to a signal that has ALREADY aborted
    // never fires, so a call that expired while queued behind the throttle would
    // otherwise still be sent.
    if (req.signal?.aborted === true) {
      clearTimeout(timer);
      throw new BackendError('Tool-call budget expired before the request was sent.', undefined, 'timeout');
    }

    // The caller's overall deadline aborts this request too.
    const onExternalAbort = (): void => controller.abort();
    req.signal?.addEventListener('abort', onExternalAbort, { once: true });

    this.#lastStart = this.#now();
    this.#requestCount += 1;

    try {
      const response = await this.#fetch(req.url, {
        method: req.method ?? 'GET',
        headers: {
          'user-agent': USER_AGENT,
          accept: 'application/json',
          ...(req.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 429) {
          // Lengthen the interval for subsequent requests and surface this one as an
          // error. No retry: retrying is out of scope for v1, and "back off" must not
          // quietly become "try again".
          let delayMs = THROTTLE_429_INTERVAL_MS;
          const retryAfter = response.headers.get('retry-after');
          if (retryAfter !== null) {
            const asSeconds = Number(retryAfter);
            if (!Number.isNaN(asSeconds)) {
              delayMs = asSeconds * 1000;
            } else {
              const asDate = Date.parse(retryAfter);
              if (!Number.isNaN(asDate)) {
                delayMs = Math.max(0, asDate - this.#now());
              }
            }
          }
          this.#interval = Math.max(this.#interval, delayMs);
        }

        // The body goes to stderr, not to the caller: it is upstream-controlled text
        // that would otherwise flow into a caller's context, and `detail` is meant to
        // carry a diagnostic class rather than an arbitrary payload.
        const body = await safeText(response);
        if (body !== undefined) {
          process.stderr.write(`upstream ${response.status} body: ${body}
`);
        }

        if (response.status === 429) {
          throw new BackendError('Upstream rate limited this client.', 429, 'rate-limited', {
            fromUpstream: true,
          });
        }

        throw new BackendError(
          'Upstream returned an error.',
          response.status,
          'http-error',
          { fromUpstream: true },
        );
      }

      const json = (await readCappedJson(response)) as T;
      this.#decayInterval();
      return json;
    } catch (error) {
      if (error instanceof BackendError) throw error;
      if (isAbortError(error)) {
        // A hang is a first-class failure mode here, not an edge case: this
        // endpoint was observed to accept a connection and then go silent.
        throw new BackendError(`Upstream did not respond within ${budget}ms.`, undefined, 'timeout');
      }
      // Node's network errors name hosts, ports and resolvers ("connect
      // ECONNREFUSED 10.0.0.5:443"), which can describe the local environment. The
      // detail stays a class; the specifics go to stderr.
      if (error instanceof Error) {
        process.stderr.write(`upstream network error: ${error.message}
`);
      }
      throw new BackendError('Upstream request failed.', undefined, 'network');
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  #decayInterval(): void {
    if (this.#interval > THROTTLE_MIN_INTERVAL_MS) {
      this.#interval = Math.max(
        THROTTLE_MIN_INTERVAL_MS,
        Math.floor(this.#interval * THROTTLE_DECAY_FACTOR),
      );
    }
  }

  async #respectInterval(): Promise<void> {
    const elapsed = this.#now() - this.#lastStart;
    if (this.#lastStart !== Number.NEGATIVE_INFINITY && elapsed < this.#interval) {
      await this.#sleep(this.#interval - elapsed);
    }
  }

  async #acquire(): Promise<void> {
    if (this.#inFlight < MAX_CONCURRENT_REQUESTS) {
      this.#inFlight += 1;
      return;
    }
    // The woken waiter does NOT increment: #release transfers the slot to it
    // directly. Decrementing first and letting the waiter re-increment a
    // microtask later leaves a window where an arriving caller passes the
    // capacity check and takes the slot too, so both proceed and the ceiling is
    // briefly exceeded.
    await new Promise<void>((resolve) => this.#queue.push(resolve));
  }

  #release(): void {
    const next = this.#queue.shift();
    if (next !== undefined) {
      // Hand the slot over without ever dropping below capacity.
      next();
      return;
    }
    this.#inFlight -= 1;
  }
}

/**
 * Reads a JSON body with a byte ceiling.
 *
 * `response.json()` buffers whatever arrives. Content-length is checked first when
 * present, and the stream is counted as it is consumed for the chunked case, so a
 * response that lies about its length is still bounded.
 */
async function readCappedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    // Not an upstream status: the response arrived fine (typically HTTP 200) and
    // this server rejected its size. Labelling it "[upstream 200]" would be
    // nonsense.
    throw new BackendError(
      `Upstream response exceeds ${MAX_RESPONSE_BYTES} bytes.`,
      undefined,
      'oversized',
    );
  }

  if (response.body === null) return JSON.parse(await response.text());

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new BackendError(
          `Upstream response exceeds ${MAX_RESPONSE_BYTES} bytes.`,
          undefined,
          'oversized',
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function safeText(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    return text.slice(0, 500);
  } catch {
    return undefined;
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name: unknown }).name === 'AbortError'
  );
}

/**
 * Tracks the wall clock for one tool call so every hop shares one deadline.
 * Without this, two sequential 8s requests would blow a 10s tool budget.
 */
export class Deadline {
  readonly #start: number;
  readonly #budgetMs: number;
  readonly #now: () => number;

  constructor(budgetMs: number, now: () => number = () => Date.now()) {
    this.#now = now;
    this.#start = now();
    this.#budgetMs = budgetMs;
  }

  remainingMs(): number {
    return Math.max(0, this.#budgetMs - (this.#now() - this.#start));
  }

  /**
   * An AbortSignal that fires when the budget runs out.
   *
   * Returned with a disposer because the timer must be cleared on the normal
   * path; a per-call timer left running keeps the event loop alive and piles up
   * under load.
   */
  abortSignal(): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, this.remainingMs()));
    return { signal: controller.signal, dispose: (): void => clearTimeout(timer) };
  }
}
