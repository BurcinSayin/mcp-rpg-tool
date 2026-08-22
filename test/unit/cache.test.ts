import { describe, expect, it } from 'vitest';
import { BoundedCache, detailCacheKey, searchCacheKey } from '../../src/cache.js';
import { SEARCH_CACHE_ENTRIES } from '../../src/constants.js';

describe('searchCacheKey', () => {
  /**
   * The bug this guards against is subtle and would have shipped: a key built from
   * the query text alone makes two searches that differ only by filter collide, so
   * the second silently returns the first's results. A naive "repeat call hits
   * cache" test passes the whole time.
   */
  it('distinguishes queries that differ only by a filter value', () => {
    const a = searchCacheKey('pf2e', 'spell', { query: 'fire', filters: { level: 3 }, limit: 10 }, '');
    const b = searchCacheKey('pf2e', 'spell', { query: 'fire', filters: { level: 5 }, limit: 10 }, '');
    expect(a).not.toBe(b);
  });

  it('distinguishes queries that differ only by limit', () => {
    const a = searchCacheKey('pf2e', 'spell', { query: 'fire', filters: {}, limit: 10 }, '');
    const b = searchCacheKey('pf2e', 'spell', { query: 'fire', filters: {}, limit: 25 }, '');
    expect(a).not.toBe(b);
  });

  it('distinguishes queries that differ only by category or system', () => {
    const base = { query: 'fire', filters: {}, limit: 10 };
    expect(searchCacheKey('pf2e', 'spell', base, '')).not.toBe(searchCacheKey('pf2e', 'feat', base, ''));
    expect(searchCacheKey('pf2e', 'spell', base, '')).not.toBe(searchCacheKey('toy', 'spell', base, ''));
  });

  it('separates continuation pages and provider policy variants', () => {
    const query = { filters: {}, limit: 3 };
    const first = searchCacheKey('pf2e', 'spell', query, 'current');
    expect(searchCacheKey('pf2e', 'spell', { ...query, cursor: 'page-two' }, 'current')).not.toBe(first);
    expect(searchCacheKey('pf2e', 'spell', query, 'legacy')).not.toBe(first);
    expect(searchCacheKey('pf2e', 'spell', { ...query, cursor: 'page-three' }, 'current'))
      .not.toBe(searchCacheKey('pf2e', 'spell', { ...query, cursor: 'page-two' }, 'current'));
  });

  it('is stable regardless of the order filters were supplied in', () => {
    const a = searchCacheKey('pf2e', 'spell', {
      query: 'fire',
      filters: { level: 3, rarity: 'common' },
      limit: 10,
    }, '');
    const b = searchCacheKey('pf2e', 'spell', {
      query: 'fire',
      filters: { rarity: 'common', level: 3 },
      limit: 10,
    }, '');
    expect(a).toBe(b);
  });

  it('separates an absent query from an empty one', () => {
    const withQuery = searchCacheKey('pf2e', 'spell', { query: 'x', filters: {}, limit: 10 }, '');
    const without = searchCacheKey('pf2e', 'spell', { filters: {}, limit: 10 }, '');
    expect(withQuery).not.toBe(without);
  });
});

describe('detailCacheKey', () => {
  it('separates ids across categories', () => {
    expect(detailCacheKey('pf2e', 'spell', 'x-1')).not.toBe(detailCacheKey('pf2e', 'feat', 'x-1'));
  });
});

describe('BoundedCache eviction', () => {
  it('evicts least-recently-used, not least-recently-inserted', () => {
    const cache = new BoundedCache<string>({ maxEntries: 3, maxBytes: 1_000_000 });
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');

    // Touching 'a' should make 'b' the eviction candidate.
    expect(cache.get('a')).toBe('1');
    cache.set('d', '4');

    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
    expect(cache.has('d')).toBe(true);
  });

  it('holds at the configured entry ceiling', () => {
    const cache = new BoundedCache<number>({
      maxEntries: SEARCH_CACHE_ENTRIES,
      maxBytes: 100_000_000,
    });
    for (let i = 0; i < SEARCH_CACHE_ENTRIES + 1; i += 1) cache.set(`k${i}`, i);

    expect(cache.stats().entries).toBe(SEARCH_CACHE_ENTRIES);
    expect(cache.has('k0')).toBe(false);
    expect(cache.has(`k${SEARCH_CACHE_ENTRIES}`)).toBe(true);
  });

  /**
   * Count alone cannot tell a small entry from an enormous one, which is how a
   * cache with a sane-looking entry limit still exhausts memory.
   */
  it('evicts on the byte bound even when far under the entry bound', () => {
    const cache = new BoundedCache<string>({ maxEntries: 1_000, maxBytes: 300 });
    cache.set('a', 'x'.repeat(200));
    cache.set('b', 'y'.repeat(200));

    expect(cache.stats().entries).toBe(1);
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
    expect(cache.stats().bytes).toBeLessThanOrEqual(300);
  });

  it('does not double-count when a key is overwritten', () => {
    const cache = new BoundedCache<string>({ maxEntries: 10, maxBytes: 10_000 });
    cache.set('a', 'x'.repeat(100));
    const first = cache.stats().bytes;
    cache.set('a', 'x'.repeat(100));

    expect(cache.stats().entries).toBe(1);
    expect(cache.stats().bytes).toBe(first);
  });

  /**
   * Keys embed caller-supplied query text, so measuring only values would leave
   * key memory outside the ceiling this class advertises. Two entries with equal
   * values and very different key lengths must not be accounted the same.
   */
  it('counts key length toward the byte bound', () => {
    const cache = new BoundedCache<string>({ maxEntries: 100, maxBytes: 1_000_000 });
    cache.set('k', 'v');
    const short = cache.stats().bytes;

    cache.clear();
    cache.set('k'.repeat(500), 'v');
    const long = cache.stats().bytes;

    // Bounded on both sides: a lower bound alone would accept an implementation
    // counting the key ten times over.
    const delta = long - short;
    expect(delta, 'key length is not counted toward the bound').toBeGreaterThanOrEqual(490);
    expect(delta, 'key length appears to be counted more than once').toBeLessThanOrEqual(520);
  });

  it('evicts on the byte bound when keys alone exceed it', () => {
    const cache = new BoundedCache<string>({ maxEntries: 100, maxBytes: 600 });
    cache.set('a'.repeat(400), 'x');
    cache.set('b'.repeat(400), 'x');

    expect(cache.stats().entries).toBe(1);
    expect(cache.stats().bytes).toBeLessThanOrEqual(600);
  });

  it('reports hits and misses', () => {
    const cache = new BoundedCache<number>({ maxEntries: 4, maxBytes: 10_000 });
    cache.set('a', 1);
    cache.get('a');
    cache.get('nope');

    const stats = cache.stats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
  });
});

describe('searchCacheKey — separator ambiguity', () => {
  /**
   * A value can contain any character, so a key joined with raw separators can be
   * imitated: with a `name=value&` join, these two produce byte-identical keys and
   * the second search silently returns the first's results. No error, no marker —
   * exactly the silently-wrong-answer class this codebase treats as its worst.
   */
  it('cannot be forged by a value containing the separators', () => {
    const twoFilters = searchCacheKey('pf2e', 'spell', {
      filters: { source: 'Player Core', trait: 'fire' },
      limit: 10,
    }, '');
    const oneCraftedFilter = searchCacheKey('pf2e', 'spell', {
      filters: { source: 'Player Core&trait=fire' },
      limit: 10,
    }, '');

    expect(twoFilters).not.toBe(oneCraftedFilter);
  });

  it('cannot be forged by a query containing the field delimiter', () => {
    const a = searchCacheKey('pf2e', 'spell', { query: 'fire', filters: { rarity: 'rare' }, limit: 10 }, '');
    const b = searchCacheKey('pf2e', 'spell', { query: 'fire|f:rarity=rare', filters: {}, limit: 10 }, '');
    expect(a).not.toBe(b);
  });
});
