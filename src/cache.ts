/**
 * Bounded LRU, in memory, for the lifetime of the process.
 *
 * A primitive, not a policy: each provider supplies its own key function, because
 * what makes a cache entry unique is a provider concern. The key must cover every
 * input that changes the result -- a key built from the query text alone would
 * make a level-3 search and a level-5 search collide and return each other's
 * results, while a naive "does a repeat call hit cache" test still passed.
 *
 * Bounded by bytes as well as count. Count alone cannot tell a 400-byte entry from
 * a ten-megabyte one.
 *
 * There is no TTL. Content changes on rulebook-release cadence, so time-based
 * invalidation buys nothing measurable; process lifetime is the effective TTL. The
 * consequence, stated rather than hidden: a long-lived process can serve content
 * stale by its own uptime.
 */

export interface CacheStats {
  entries: number;
  bytes: number;
  hits: number;
  misses: number;
  evictions: number;
}

interface Entry<V> {
  value: V;
  bytes: number;
}

export class BoundedCache<V> {
  readonly #map = new Map<string, Entry<V>>();
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  readonly #sizeOf: (value: V) => number;

  #bytes = 0;
  #hits = 0;
  #misses = 0;
  #evictions = 0;

  constructor(options: {
    maxEntries: number;
    maxBytes: number;
    sizeOf?: (value: V) => number;
  }) {
    this.#maxEntries = options.maxEntries;
    this.#maxBytes = options.maxBytes;
    this.#sizeOf = options.sizeOf ?? approximateBytes;
  }

  get(key: string): V | undefined {
    const found = this.#map.get(key);
    if (found === undefined) {
      this.#misses += 1;
      return undefined;
    }
    // Re-insert to move to the most-recently-used end. Map preserves insertion order.
    this.#map.delete(key);
    this.#map.set(key, found);
    this.#hits += 1;
    return found.value;
  }

  set(key: string, value: V): void {
    const existing = this.#map.get(key);
    if (existing !== undefined) {
      this.#bytes -= existing.bytes;
      this.#map.delete(key);
    }

    // Key length counts toward the bound. Keys embed caller-supplied query text, so
    // measuring only values would leave key memory outside the ceiling this class
    // claims to enforce — a stated bound that is not the real bound.
    const bytes = this.#sizeOf(value) + key.length;
    if (bytes > this.#maxBytes) {
      return;
    }
    this.#map.set(key, { value, bytes });
    this.#bytes += bytes;

    this.#evictUntilWithinBounds();
  }

  has(key: string): boolean {
    return this.#map.has(key);
  }

  clear(): void {
    this.#map.clear();
    this.#bytes = 0;
  }

  stats(): CacheStats {
    return {
      entries: this.#map.size,
      bytes: this.#bytes,
      hits: this.#hits,
      misses: this.#misses,
      evictions: this.#evictions,
    };
  }

  #evictUntilWithinBounds(): void {
    while (
      (this.#map.size > this.#maxEntries || this.#bytes > this.#maxBytes) &&
      this.#map.size > 0
    ) {
      // Oldest insertion is the least recently used, because `get` re-inserts.
      const oldestKey = this.#map.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.#map.get(oldestKey);
      if (oldest !== undefined) this.#bytes -= oldest.bytes;
      this.#map.delete(oldestKey);
      this.#evictions += 1;
    }
  }
}

/**
 * Cheap size estimate. Exact byte accounting would mean serializing on every
 * write; the bound exists to stop unbounded growth, not to be an allocator.
 */
function approximateBytes(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Builds a cache key covering every input that can change a result.
 *
 * Filters and limit are included deliberately: omitting them is the collision bug
 * described above. Filter keys are sorted so argument order cannot produce two
 * keys for one logical query.
 */
export function searchCacheKey(
  systemKey: string,
  categoryKey: string,
  query: { query?: string; filters: Readonly<Record<string, unknown>>; limit: number; cursor?: string },
  variant: string,
): string {
  // Serialized as JSON rather than joined with separators. Filter values are
  // caller-supplied strings, so any separator character can appear inside one: with
  // a `name=value&` join, {source: "Player Core&trait=fire"} produces a key byte-
  // identical to {source: "Player Core", trait: "fire"}. That is a forged cache hit
  // returning a plausible wrong answer with no error and no marker — the same
  // silently-wrong-result failure the omitted-fields bug above would have caused,
  // reached through the encoding instead of through the field list.
  //
  // JSON quoting escapes the separators, so no value can imitate the structure.
  const filterPairs = Object.keys(query.filters)
    .sort()
    .map((name) => [name, query.filters[name]] as const);

  return JSON.stringify([systemKey, categoryKey, query.query ?? null, filterPairs, query.limit, variant, query.cursor ?? null]);
}

export function detailCacheKey(systemKey: string, categoryKey: string, id: string): string {
  return `${systemKey}|${categoryKey}|${id}`;
}
