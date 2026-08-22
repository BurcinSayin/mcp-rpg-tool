import { describe, expect, it } from 'vitest';
import { Pf2eProvider, PF2E_CATEGORIES } from '../../src/provider/pf2e/index.js';
import { SearchCursorStore } from '../../src/pagination.js';
import { HttpClient } from '../../src/http.js';
import { BoundedCache } from '../../src/cache.js';
import { BackendError, type SearchResult } from '../../src/provider/types.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

const spellCategory = PF2E_CATEGORIES.find((c) => c.key === 'spell')!;

describe('Pf2eProvider search', () => {
  it('advances beyond raw hits without usable IDs even when the mapped page is empty', async () => {
    const rows = [
      { _index: 'aon-current', sort: [1, 'spell-1'], _source: { name: 'No ID' } },
      { _index: 'aon-current', sort: [1, 'spell-2'] },
      { _index: 'aon-current', sort: [1, 'spell-3'], _id: 'spell-3', _source: { name: 'Valid' } },
    ];
    const http = new HttpClient({
      sleep: async () => {},
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { search_after?: [number, string] };
        return jsonResponse({ hits: { hits: body.search_after === undefined ? rows : rows.slice(2) } });
      },
    });
    const provider = new Pf2eProvider({ http });
    const first = await provider.search(spellCategory, { filters: {}, limit: 2 });
    expect(first.entries).toEqual([]);
    expect(first.nextCursor).toBeDefined();
    const second = await provider.search(spellCategory, { filters: {}, limit: 2, cursor: first.nextCursor });
    expect(second.entries.map((entry) => entry.id)).toEqual(['spell-3']);
    expect(second).not.toHaveProperty('nextCursor');
  });

  it('makes only one request for identical consecutive searches (cache round-trip)', async () => {
    let requests = 0;
    const http = new HttpClient({
      fetchImpl: (() => {
        requests += 1;
        return Promise.resolve(jsonResponse({ hits: { hits: [] } }));
      }) as unknown as typeof fetch,
    });
    const provider = new Pf2eProvider({ http });

    await provider.search(spellCategory, { query: 'fireball', filters: {}, limit: 10 });
    expect(requests).toBe(1);
    expect(http.requestCount).toBe(1);

    await provider.search(spellCategory, { query: 'fireball', filters: {}, limit: 10 });
    expect(requests).toBe(1); // Cached, no new request
    expect(http.requestCount).toBe(1);

    await provider.search(spellCategory, { query: 'fireball', filters: { level: 3 }, limit: 10 });
    expect(requests).toBe(2); // Varied filter causes new request
    expect(http.requestCount).toBe(2);
  });

  it('drops superseded legacy documents (canonicity drop)', async () => {
    const legacyDoc = {
      _index: 'aon-2026-01',
      _id: 'spell-119',
      sort: [1, 'spell-119'],
      _source: {
        id: 'spell-119',
        name: 'Fireball',
        type: 'Spell',
        remaster_id: ['spell-1530'], // Marking it as superseded
      },
    };

    const currentDoc = {
      _index: 'aon-2026-01',
      _id: 'spell-1530',
      sort: [1, 'spell-1530'],
      _source: {
        id: 'spell-1530',
        name: 'Fireball',
        type: 'Spell',
      },
    };

    const http = new HttpClient({
      fetchImpl: (() => {
        return Promise.resolve(jsonResponse({ hits: { hits: [legacyDoc, currentDoc] } }));
      }) as unknown as typeof fetch,
    });

    const provider = new Pf2eProvider({ http }); // includeLegacy is false by default

    const result = await provider.search(spellCategory, { query: 'fireball', filters: {}, limit: 10 });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.id).toBe('spell-1530');
    // Result should be marked as degraded because of the dropped document
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toContain('1 superseded entry');
  });

  it('throws a BackendError if all results are dropped due to canonicity', async () => {
    const legacyDoc = {
      _index: 'aon-2026-01',
      _id: 'spell-119',
      sort: [1, 'spell-119'],
      _source: {
        id: 'spell-119',
        name: 'Fireball',
        type: 'Spell',
        remaster_id: ['spell-1530'],
      },
    };

    const http = new HttpClient({
      fetchImpl: (() => {
        return Promise.resolve(jsonResponse({ hits: { hits: [legacyDoc] } }));
      }) as unknown as typeof fetch,
    });

    const provider = new Pf2eProvider({ http });

    await expect(provider.search(spellCategory, { query: 'fireball', filters: {}, limit: 10 })).rejects.toThrow(
      BackendError,
    );
    await expect(provider.search(spellCategory, { query: 'fireball', filters: {}, limit: 10 })).rejects.toMatchObject({
      detail: 'canonicity-regression',
    });
  });

  it('throws an unexpected-shape error if hits is undefined', async () => {
    const http = new HttpClient({
      fetchImpl: (() => {
        return Promise.resolve(jsonResponse({})); // No hits object
      }) as unknown as typeof fetch,
    });

    const provider = new Pf2eProvider({ http });

    await expect(provider.search(spellCategory, { query: 'fireball', filters: {}, limit: 10 })).rejects.toThrow(
      BackendError,
    );
    await expect(provider.search(spellCategory, { query: 'fireball', filters: {}, limit: 10 })).rejects.toMatchObject({
      detail: 'unexpected-shape',
    });
  });

  it('traverses tied-score documents once, replaying pages from the cache', async () => {
    const docs = Array.from({ length: 7 }, (_, index) => {
      const id = `spell-${index + 1}`;
      return {
        _index: 'aon-2026-01',
        _id: id,
        sort: [1, id],
        _source: { id, name: `Spell ${index + 1}`, type: 'Spell' },
      };
    });
    let requests = 0;
    const http = new HttpClient({
      fetchImpl: ((_: Parameters<typeof fetch>[0], init?: RequestInit) => {
        requests += 1;
        const body = JSON.parse(String(init?.body)) as { search_after?: readonly [number, string]; size: number };
        const after = body.search_after?.[1];
        const start = after === undefined ? 0 : docs.findIndex((doc) => doc._id === after) + 1;
        return Promise.resolve(jsonResponse({ hits: { hits: docs.slice(start, start + body.size) } }));
      }) as typeof fetch,
    });
    const provider = new Pf2eProvider({ http });
    const request = { query: 'spell', filters: {}, limit: 3 };

    const first = await provider.search(spellCategory, request);
    const second = await provider.search(spellCategory, { ...request, cursor: first.nextCursor });
    const replay = await provider.search(spellCategory, { ...request, cursor: first.nextCursor });
    const third = await provider.search(spellCategory, { ...request, cursor: second.nextCursor });

    expect(first.entries.map((entry) => entry.id)).toEqual(['spell-1', 'spell-2', 'spell-3']);
    expect(second.entries.map((entry) => entry.id)).toEqual(['spell-4', 'spell-5', 'spell-6']);
    expect(replay.entries.map((entry) => entry.id)).toEqual(['spell-4', 'spell-5', 'spell-6']);
    expect(third.entries.map((entry) => entry.id)).toEqual(['spell-7']);
    expect(third.nextCursor).toBeUndefined();
    expect(requests).toBe(3);
  });

  it('rejects an expired incoming cursor and refreshes a first-page cache entry with a dead cursor', async () => {
    let now = 0;
    let requests = 0;
    const http = new HttpClient({
      fetchImpl: (() => {
        requests += 1;
        return Promise.resolve(
          jsonResponse({
            hits: {
              hits: [
                {
                  _index: 'aon-2026-01',
                  _id: 'spell-1',
                  sort: [1, 'spell-1'],
                  _source: { id: 'spell-1', name: 'Spell 1', type: 'Spell' },
                },
                {
                  _index: 'aon-2026-01',
                  _id: 'spell-2',
                  sort: [1, 'spell-2'],
                  _source: { id: 'spell-2', name: 'Spell 2', type: 'Spell' },
                },
              ],
            },
          }),
        );
      }) as unknown as typeof fetch,
    });
    const provider = new Pf2eProvider({
      http,
      cursors: new SearchCursorStore<string>({ now: () => now }),
    });
    const request = { query: 'spell', filters: {}, limit: 1 };
    const first = await provider.search(spellCategory, request);
    now = 15 * 60 * 1000;

    await expect(
      provider.search(spellCategory, { ...request, cursor: first.nextCursor }),
    ).rejects.toMatchObject({ detail: 'invalid-cursor' });
    await provider.search(spellCategory, request);
    expect(requests).toBe(2);
  });

  it('isolates shared search caches by canonicity policy', async () => {
    const sharedCache = new BoundedCache<SearchResult>({ maxEntries: 20, maxBytes: 100_000 });
    let requests = 0;
    const http = new HttpClient({
      fetchImpl: (() => {
        requests += 1;
        return Promise.resolve(
          jsonResponse({
            hits: {
              hits: [
                {
                  _index: 'aon-2026-01',
                  _id: 'spell-119',
                  sort: [1, 'spell-119'],
                  _source: {
                    id: 'spell-119',
                    name: 'Fireball',
                    type: 'Spell',
                    remaster_id: ['spell-1530'],
                  },
                },
                {
                  _index: 'aon-2026-01',
                  _id: 'spell-1530',
                  sort: [1, 'spell-1530'],
                  _source: { id: 'spell-1530', name: 'Fireball', type: 'Spell' },
                },
              ],
            },
          }),
        );
      }) as unknown as typeof fetch,
    });
    const current = new Pf2eProvider({ http, searchCache: sharedCache });
    const legacy = new Pf2eProvider({
      http,
      searchCache: sharedCache,
      env: { INCLUDE_LEGACY: 'true' },
    });
    const request = { query: 'fireball', filters: {}, limit: 10 };

    expect((await current.search(spellCategory, request)).entries).toHaveLength(1);
    expect((await legacy.search(spellCategory, request)).entries).toHaveLength(2);
    expect(requests).toBe(2);
  });

  it('continues after a dropped legacy document at a raw-page boundary', async () => {
    const docs = [
      {
        _index: 'aon-2026-01',
        _id: 'spell-119',
        sort: [1, 'spell-119'],
        _source: { id: 'spell-119', name: 'Old spell', type: 'Spell', remaster_id: ['spell-1530'] },
      },
      {
        _index: 'aon-2026-01',
        _id: 'spell-1530',
        sort: [1, 'spell-1530'],
        _source: { id: 'spell-1530', name: 'New spell', type: 'Spell' },
      },
      {
        _index: 'aon-2026-01',
        _id: 'spell-2000',
        sort: [1, 'spell-2000'],
        _source: { id: 'spell-2000', name: 'Later spell', type: 'Spell' },
      },
    ];
    const http = new HttpClient({
      fetchImpl: ((_: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { search_after?: readonly [number, string]; size: number };
        const after = body.search_after?.[1];
        const start = after === undefined ? 0 : docs.findIndex((doc) => doc._id === after) + 1;
        return Promise.resolve(jsonResponse({ hits: { hits: docs.slice(start, start + body.size) } }));
      }) as typeof fetch,
    });
    const provider = new Pf2eProvider({ http });
    const request = { query: 'spell', filters: {}, limit: 2 };

    const first = await provider.search(spellCategory, request);
    const second = await provider.search(spellCategory, { ...request, cursor: first.nextCursor });
    expect(first.entries.map((entry) => entry.id)).toEqual(['spell-1530']);
    expect(first.degraded).toBe(true);
    expect(second.entries.map((entry) => entry.id)).toEqual(['spell-2000']);
    expect(second.nextCursor).toBeUndefined();
  });
});
