/**
 * The live suite. Opt-in, never CI-gating: `npm run test:live`.
 *
 * Its job is the one failure mode fixtures structurally cannot catch — the upstream
 * schema or behaviour changing under us. A recorded fixture keeps passing forever
 * precisely because it is a recording, so a suite built only on fixtures grows more
 * confident as it grows more wrong.
 *
 * Archives of Nethys is community infrastructure with no published rate limit, so
 * this suite stays small and deliberate. It is not a benchmark and must never
 * become a corpus scan.
 */

import { describe, expect, it } from 'vitest';
import {
  AON_MGET_URL,
  AON_SEARCH_URL,
  buildSearchBody,
} from '../../src/provider/pf2e/client.js';
import { USER_AGENT } from '../../src/constants.js';
import { AON_TYPE_BY_KEY, createPf2eProvider } from '../../src/provider/pf2e/index.js';

const headers = {
  'content-type': 'application/json',
  'user-agent': USER_AGENT,
  accept: 'application/json',
};

async function search(body: unknown): Promise<{
  hits: { total: { value: number }; hits: Array<{ _source: Record<string, unknown> }> };
}> {
  const response = await fetch(AON_SEARCH_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  expect(response.ok, `search failed: HTTP ${response.status}`).toBe(true);
  return (await response.json()) as never;
}

describe('upstream availability', () => {
  it('reaches the alias, not a dated concrete index', async () => {
    const result = await search({ size: 1, query: { match_all: {} } });
    expect(result.hits.total.value).toBeGreaterThan(0);
  });

  it('still answers _mget for the details path', async () => {
    const response = await fetch(AON_MGET_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ids: ['spell-1530'] }),
    });
    expect(response.ok).toBe(true);

    const payload = (await response.json()) as {
      docs: Array<{ found: boolean; _source?: Record<string, unknown> }>;
    };
    expect(payload.docs[0]?.found).toBe(true);
    expect(payload.docs[0]?._source?.['name']).toBe('Fireball');
  });
});

describe('the minimum_should_match guard, against the live index', () => {
  /**
   * This is the assertion that justifies the whole guard, and it only means
   * anything live: it demonstrates the trap is still real upstream rather than a
   * quirk of a recording. If Elasticsearch behaviour ever changed such that the
   * first case returned zero, the guard would be redundant — and we would want to
   * know that rather than assume it.
   */
  it('without the guard, a nonsense query returns the whole category', async () => {
    const body = buildSearchBody(
      { aonType: 'spell', text: 'asdfgh', filterValues: {}, limit: 3, budgetMs: 8_000 },
      false,
    );
    // Deliberately remove the guard to observe the underlying behaviour.
    delete (body.query.bool as { minimum_should_match?: number }).minimum_should_match;

    const result = await search(body);
    expect(result.hits.total.value).toBeGreaterThan(100);
  });

  it('with the guard, the same query returns nothing', async () => {
    const body = buildSearchBody(
      { aonType: 'spell', text: 'asdfgh', filterValues: {}, limit: 3, budgetMs: 8_000 },
      false,
    );
    expect(body.query.bool.minimum_should_match).toBe(1);

    const result = await search(body);
    expect(result.hits.total.value).toBe(0);
  });
});

describe('Remaster canonicity, against the live index', () => {
  it('still has both Fireballs, so the filter is still necessary', async () => {
    // An `ids` query rather than a term on `id`: those fields are analyzed, so a
    // term match silently returns nothing and the test would fail for a reason
    // that has nothing to do with the property being checked.
    const result = await search({
      size: 10,
      _source: ['id', 'name', 'remaster_id'],
      query: { ids: { values: ['spell-119', 'spell-1530'] } },
    });

    const ids = result.hits.hits.map((h) => h._source['id']);
    expect(ids).toContain('spell-119');
    expect(ids).toContain('spell-1530');
  });

  it('excludes the superseded one under the default filter', async () => {
    const body = buildSearchBody(
      { aonType: 'spell', text: 'Fireball', filterValues: {}, limit: 10, budgetMs: 8_000 },
      false,
    );
    const result = await search(body);
    const ids = result.hits.hits.map((h) => h._source['id']);

    expect(ids).not.toContain('spell-119');
    expect(ids).toContain('spell-1530');
  });

  it('keeps the directional cross-reference the filter depends on', async () => {
    const result = await search({
      size: 1,
      _source: ['id', 'remaster_id'],
      query: { ids: { values: ['spell-119'] } },
    });
    // The legacy document points forward. That field's presence is the entire
    // signal used to exclude superseded content.
    expect(result.hits.hits[0]?._source['remaster_id']).toBeDefined();
  });
});

describe('declared filters are honoured by the backend', () => {
  /**
   * A backend can accept a parameter and ignore it, which is worse than not
   * offering the filter at all — the caller believes it filtered. A bogus value is
   * the cheapest way to tell the difference: a filter that works returns nothing,
   * an ignored one returns the unfiltered set.
   */
  it('a value that cannot match returns nothing, not everything', async () => {
    const body = buildSearchBody(
      {
        aonType: 'spell',
        filterValues: { rarity: 'definitely-not-a-rarity' },
        limit: 3,
        budgetMs: 8_000,
      },
      false,
    );
    const result = await search(body);
    expect(result.hits.total.value).toBe(0);
  });

  it('a real filter value narrows rather than passing everything through', async () => {
    const unfiltered = await search(
      buildSearchBody(
        { aonType: 'spell', filterValues: {}, limit: 1, budgetMs: 8_000 },
        false,
      ),
    );
    const filtered = await search(
      buildSearchBody(
        { aonType: 'spell', filterValues: { level: 3 }, limit: 1, budgetMs: 8_000 },
        false,
      ),
    );

    expect(filtered.hits.total.value).toBeGreaterThan(0);
    expect(filtered.hits.total.value).toBeLessThan(unfiltered.hits.total.value);
  });
});

describe('every declared category still has content', () => {
  /**
   * Guards the defect where a category is declared, generates a tool, and returns
   * nothing forever because the upstream taxonomy moved. Runs as a single
   * aggregation rather than one request per category — sixteen requests to answer
   * one question would be exactly the discourtesy this suite is careful about.
   */
  it('under the Remaster filter, no declared category is empty', async () => {
    const provider = createPf2eProvider({});

    const result = (await (
      await fetch(AON_SEARCH_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          size: 0,
          query: {
            bool: {
              must_not: [
                { exists: { field: 'remaster_id' } },
                { term: { exclude_from_search: true } },
              ],
            },
          },
          aggs: { types: { terms: { field: 'type', size: 130 } } },
        }),
      })
    ).json()) as { aggregations: { types: { buckets: Array<{ key: string; doc_count: number }> } } };

    const counts = new Map(result.aggregations.types.buckets.map((b) => [b.key, b.doc_count]));

    const empty: string[] = [];
    for (const category of provider.categories) {
      // The mapping the client queries with, not a re-derivation of it. Deriving
      // the type from the slug here would validate a translation the production
      // code does not use: change an entry in the real table to something wrong
      // and every search for that category returns nothing forever, while this
      // test -- named "no declared category is empty" -- keeps passing.
      const aonType = AON_TYPE_BY_KEY.get(category.key);
      expect(aonType, `no AoN type mapped for category "${category.key}"`).toBeDefined();
      if ((counts.get(aonType!) ?? 0) === 0) empty.push(category.key);
    }

    expect(empty, `declared categories with no content upstream: ${empty.join(', ')}`).toEqual([]);
  });

  /**
   * The declared size is a snapshot, and a snapshot nothing compares against is a
   * literal maintained by hand alongside the thing it claims to describe. The
   * aggregation above already holds the real per-category count, so checking it
   * here converts approximateSize from decorative to verified.
   *
   * Tolerant by design: upstream content grows, and this suite exists to report
   * drift rather than to fail on every rulebook release. A wrong snapshot is a
   * different thing from a stale one.
   */
  it('declare category sizes within range of the real counts', async () => {
    const provider = createPf2eProvider({});

    const result = (await (
      await fetch(AON_SEARCH_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          size: 0,
          query: {
            bool: {
              must_not: [
                { exists: { field: 'remaster_id' } },
                { term: { exclude_from_search: true } },
              ],
            },
          },
          aggs: { types: { terms: { field: 'type', size: 130 } } },
        }),
      })
    ).json()) as { aggregations: { types: { buckets: Array<{ key: string; doc_count: number }> } } };

    const counts = new Map(result.aggregations.types.buckets.map((b) => [b.key, b.doc_count]));
    const drifted: string[] = [];

    for (const category of provider.categories) {
      const aonType = AON_TYPE_BY_KEY.get(category.key);
      const actual = counts.get(aonType!) ?? 0;
      const declared = category.approximateSize;
      const ratio = actual === 0 ? Infinity : Math.abs(actual - declared) / actual;
      if (ratio > 0.2) drifted.push(`${category.key}: declared ${declared}, upstream ${actual}`);
    }

    expect(drifted, `approximateSize is more than 20% out for: ${drifted.join('; ')}`).toEqual([]);
  });
});

describe('the document shape the mapper depends on', () => {
  it('still carries the fields summaries and entries are built from', async () => {
    const result = await search({
      size: 1,
      query: { ids: { values: ['spell-1530'] } },
    });

    const doc = result.hits.hits[0]?._source;
    expect(doc, 'spell-1530 should still exist').toBeDefined();

    // Includes the fields the mappers PREFER, not only the fallbacks. All seven
    // were confirmed present on a live document; if any disappears the preferred
    // branch silently starts taking the fallback, which is exactly the kind of
    // change a fixture-only suite cannot see.
    for (const field of [
      'id', 'name', 'type', 'level', 'text', 'source', 'url',
      'summary', 'source_raw', 'trait', 'trait_raw', 'markdown', 'rarity',
      // The only field in the client-side canonicity drop whose upstream presence
      // was otherwise unverified.
      'exclude_from_search',
    ]) {
      expect(doc?.[field], `upstream document lost the "${field}" field`).toBeDefined();
    }
  });
});
