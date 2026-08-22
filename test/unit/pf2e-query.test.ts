/**
 * Assertions on the Pathfinder query itself.
 *
 * These guard the two failure modes that were verified against the live index and
 * that a reader could not detect on their own: a no-match query returning the
 * whole category, and superseded rules being returned as current.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  AON_MGET_URL,
  AON_SEARCH_URL,
  AonClient,
  buildSearchBody,
  type AonDocument,
} from '../../src/provider/pf2e/client.js';
import { HttpClient, type HttpRequest } from '../../src/http.js';
import {
  absoluteUrl,
  canonicityOf,
  isExcludedDoc,
  isSupersededDoc,
  shouldDropDoc,
  supersededByOf,
  toEntry,
  toSummary,
} from '../../src/provider/pf2e/map.js';
import { createPf2eProvider } from '../../src/provider/pf2e/index.js';
import { MAX_BODY_CHARS, MAX_SUMMARY_CHARS } from '../../src/constants.js';

const body = (over: Partial<Parameters<typeof buildSearchBody>[0]> = {}, legacy = false) =>
  buildSearchBody(
    { aonType: 'spell', limit: 10, filterValues: {}, budgetMs: 8_000, ...over },
    legacy,
  );

describe('minimum_should_match — the confidently-wrong-answer guard', () => {
  /**
   * Verified live before this code existed: with `should` clauses present and
   * `minimum_should_match` absent, querying "asdfgh" against type=spell returned
   * 1811 hits — every spell in the index, led by Abyssal Plague. Elasticsearch
   * drops `should` to score-only as soon as a `filter` clause is present, so the
   * text query stops constraining anything at all.
   *
   * The result is not an error. It is ten plausible spells, confidently returned,
   * for a query that matched nothing.
   */
  it('is set whenever a text query is present', () => {
    const built = body({ text: 'fireball' });
    expect(built.query.bool.should?.length ?? 0).toBeGreaterThan(0);
    expect(built.query.bool.minimum_should_match).toBe(1);
  });

  it('is absent when there is no text query, so a filter-only search still matches its category', () => {
    const built = body({ filterValues: { level: 3 } });
    expect(built.query.bool.should ?? []).toHaveLength(0);
    expect(built.query.bool.minimum_should_match).toBeUndefined();
  });

  it('is set for a nonsense query too — the guard is structural, not content-dependent', () => {
    expect(body({ text: 'asdfgh' }).query.bool.minimum_should_match).toBe(1);
  });
});

describe('canonicity filtering', () => {
  /**
   * Exact clauses, not substrings of the serialized query. `toContain('remaster_id')`
   * survives the clause changing from `{exists:{field:'remaster_id'}}` to
   * `{term:{remaster_id:true}}` -- which inverts the filter's meaning while the test
   * stays green, because the field name still appears somewhere in the JSON.
   */
  it('excludes superseded and suppressed documents by default', () => {
    const mustNot = body({ text: 'fireball' }).query.bool.must_not ?? [];
    expect(mustNot).toContainEqual({ exists: { field: 'remaster_id' } });
    expect(mustNot).toContainEqual({ term: { exclude_from_search: true } });
  });

  it('drops the exclusions when legacy content is explicitly requested', () => {
    expect(body({ text: 'fireball' }, true).query.bool.must_not ?? []).toHaveLength(0);
  });

  /**
   * Iterated over several categories deliberately. Asserting only the spell case
   * left the "requested" half of this test's name unguarded: hardcoding
   * `{term:{type:'spell'}}` in the builder would break fifteen of sixteen
   * categories in production and still pass here, because the helper only ever
   * asked for spells.
   */
  it('filters to the requested category, whichever it is', () => {
    for (const aonType of ['spell', 'feat', 'creature', 'class feature']) {
      expect(
        body({ text: 'x', aonType }).query.bool.filter,
        `filter did not narrow to "${aonType}"`,
      ).toContainEqual({ term: { type: aonType } });
    }
  });
});

describe('endpoint binding', () => {
  /**
   * The concrete index rotates (aon-20260802-141253 was observed). Binding to the
   * alias is what keeps the client working across a reindex.
   */
  it('uses the stable alias, never a dated concrete index', () => {
    for (const url of [AON_SEARCH_URL, AON_MGET_URL]) {
      expect(url).toContain('/aon/');
      expect(url).not.toMatch(/aon-\d{8}/);
    }
  });
});

describe('AoN search pagination transport', () => {
  const request = {
    aonType: 'spell',
    filterValues: {},
    limit: 2,
    budgetMs: 8_000,
  };
  const hit = (
    id: string,
    score: number,
    index = 'aon-20260916',
    source: AonDocument | undefined = { id, name: id },
  ) => ({ _id: id, _index: index, _source: source, sort: [score, id] });

  const clientFor = (...responses: unknown[]) => {
    const requests: HttpRequest[] = [];
    const http = {
      requestJson: async <T>(input: HttpRequest): Promise<T> => {
        requests.push(input);
        const response = responses.shift();
        return (typeof response === 'function' ? response(input) : response) as T;
      },
    };
    return { client: new AonClient(http as HttpClient, { includeLegacy: false }), requests };
  };

  it('uses stable sorting, a raw-hit lookahead, and a backend-only search_after tuple', () => {
    const built = body({ continuation: JSON.stringify({ index: 'aon-current', after: [2, 'spell-2'] }) });
    expect(built.sort).toEqual(['_score', 'id.keyword']);
    expect(built.size).toBe(11);
    expect(built.search_after).toEqual([2, 'spell-2']);
  });

  it('advances from the last consumed raw hit, even when raw hits lack source data', async () => {
    const { client, requests } = clientFor({
      hits: { hits: [hit('spell-1', 4, 'aon-current'), { ...hit('spell-2', 3, 'aon-current'), _source: undefined }, hit('spell-3', 2, 'aon-current')] },
    });

    const page = await client.search(request);
    expect(page.documents.map((document) => document.id)).toEqual(['spell-1']);
    expect(JSON.parse(page.continuation ?? '')).toEqual({
      index: 'aon-current',
      after: [3, 'spell-2'],
    });
    expect(requests[0]?.body).toMatchObject({ size: 3 });
  });

  it('omits continuation for zero hits and exactly one full page', async () => {
    expect(await clientFor({ hits: { hits: [] } }).client.search(request)).toEqual({ documents: [] });
    const page = await clientFor({ hits: { hits: [
      hit('spell-1', 2, 'aon-current', { name: 'Fallback ID' }),
      hit('spell-2', 1, 'aon-current'),
    ] } }).client.search(request);
    expect(page.documents.map((doc) => doc.id)).toEqual(['spell-1', 'spell-2']);
    expect(page).not.toHaveProperty('continuation');
  });

  it('rejects malformed continuation and hit metadata rather than advancing ambiguously', async () => {
    const badContinuation = clientFor({ hits: { hits: [] } });
    await expect(badContinuation.client.search({ ...request, continuation: 'not json' })).rejects.toMatchObject({
      detail: 'unexpected-shape',
    });

    for (const response of [
      null,
      { hits: { hits: {} } },
      { hits: { hits: [{ ...hit('spell-1', 1), _index: '' }] } },
      { hits: { hits: [{ ...hit('spell-1', 1), sort: [Infinity, 'spell-1'] }] } },
      { hits: { hits: [{ ...hit('spell-1', 1), sort: [1, ''] }] } },
      { hits: { hits: [{ ...hit('spell-1', 1), sort: [1] }] } },
      { hits: { hits: [hit('spell-1', 1), hit('spell-2', 2, 'another-index')] } },
      { hits: { hits: [hit('spell-1', 1)] }, timed_out: true },
      { hits: { hits: [hit('spell-1', 1)] }, _shards: { failed: 1 } },
    ]) {
      const { client } = clientFor(response);
      await expect(client.search(request)).rejects.toMatchObject({ detail: 'unexpected-shape' });
    }
  });

  it('rejects changed indexes and probes alias identity before completing an empty continuation page', async () => {
    const continuation = JSON.stringify({ index: 'aon-before', after: [1, 'spell-1'] });
    const changed = clientFor({ hits: { hits: [hit('spell-2', 0, 'aon-after')] } });
    await expect(changed.client.search({ ...request, continuation })).rejects.toMatchObject({
      detail: 'invalid-cursor',
    });

    const same = clientFor(
      { hits: { hits: [] } },
      { hits: { hits: [{ _index: 'aon-before' }] } },
    );
    await expect(same.client.search({ ...request, continuation })).resolves.toEqual({ documents: [] });
    expect(same.requests[1]?.body).toEqual({ size: 1, query: { match_all: {} }, _source: false });

    const empty = clientFor({ hits: { hits: [] } }, { hits: { hits: [] } });
    await expect(empty.client.search({ ...request, continuation })).rejects.toMatchObject({
      detail: 'invalid-cursor',
    });
    const rotated = clientFor({ hits: { hits: [] } }, { hits: { hits: [{ _index: 'aon-after' }] } });
    await expect(rotated.client.search({ ...request, continuation })).rejects.toMatchObject({
      detail: 'invalid-cursor',
    });
  });

  it('aborts the real identity probe on the original signal or remaining budget', async () => {
    vi.useFakeTimers();
    try {
      for (const externalAbort of [true, false]) {
        const controller = new AbortController();
        let calls = 0;
        const http = new HttpClient({
          sleep: async () => {},
          fetchImpl: async (_url, init) => {
            calls++;
            if (calls === 1) {
              await new Promise((resolve) => setTimeout(resolve, 30));
              return new Response(JSON.stringify({ hits: { hits: [] } }));
            }
            return await new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
            });
          },
        });
        const client = new AonClient(http, { includeLegacy: false });
        const pending = client.search({
          ...request,
          budgetMs: 50,
          continuation: JSON.stringify({ index: 'aon-current', after: [1, 'spell-1'] }),
          signal: controller.signal,
        });
        const rejected = expect(pending).rejects.toMatchObject({ detail: 'timeout' });
        await vi.advanceTimersByTimeAsync(30);
        expect(calls).toBe(2);
        if (externalAbort) controller.abort();
        else await vi.advanceTimersByTimeAsync(20);
        await rejected;
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('document mapping', () => {
  const legacyDoc: AonDocument = {
    id: 'spell-119',
    name: 'Fireball',
    type: 'Spell',
    level: 3,
    text: 'A roaring blast of fire.',
    remaster_id: ['spell-1530'],
    source: ['Core Rulebook'],
    url: '/Spells.aspx?ID=119',
  } as AonDocument;

  const currentDoc: AonDocument = {
    id: 'spell-1530',
    name: 'Fireball',
    type: 'Spell',
    level: 3,
    text: 'A roaring blast of fire.',
    source: ['Player Core'],
    url: '/Spells.aspx?ID=1530',
  } as AonDocument;

  it('recognises a superseded document', () => {
    expect(canonicityOf(legacyDoc)).toBe('legacy');
    expect(supersededByOf(legacyDoc)).toBe('spell-1530');
    expect(shouldDropDoc(legacyDoc)).toBe(true);
  });

  /**
   * Presence, not parseability. A remaster_id of an unexpected shape must still
   * mean "superseded": the server-side `exists` filter would exclude such a
   * document from search, so treating it as current on the details path would
   * make the two halves of the canonicity guarantee disagree about one document.
   */
  it('treats an unparseable remaster_id as superseded rather than current', () => {
    for (const odd of [42, { id: 'spell-1530' }, true]) {
      const doc = { ...legacyDoc, remaster_id: odd } as unknown as AonDocument;
      expect(isSupersededDoc(doc), `remaster_id=${JSON.stringify(odd)} read as current`).toBe(true);
      expect(canonicityOf(doc)).toBe('legacy');
      expect(shouldDropDoc(doc)).toBe(true);
    }
  });

  /**
   * The cases above all hit the catch-all. These hit the two length-based branches,
   * and they are the ones that decide the OTHER way -- so they are where the two
   * halves of the canonicity guarantee could disagree.
   *
   * It matters that they read as current: Elasticsearch's `exists` does not match
   * an empty array, so the server-side filter would keep such a document. If the
   * client-side drop removed it anyway, search and details would disagree about the
   * same entry.
   */
  it('treats an empty remaster_id as current, matching what the server-side filter does', () => {
    for (const empty of [[], '']) {
      const doc = { ...legacyDoc, remaster_id: empty } as unknown as AonDocument;
      expect(
        isSupersededDoc(doc),
        `remaster_id=${JSON.stringify(empty)} read as superseded; ES exists would not match it`,
      ).toBe(false);
      expect(canonicityOf(doc)).toBe('current');
      expect(shouldDropDoc(doc)).toBe(false);
    }
  });

  it('recognises the current document, which points back rather than forward', () => {
    expect(canonicityOf(currentDoc)).toBe('current');
    expect(supersededByOf(currentDoc)).toBeUndefined();
    expect(shouldDropDoc(currentDoc)).toBe(false);
  });

  /**
   * The details path matters as much as search: fetching by id bypasses the search
   * query entirely, so a legacy id resolves straight to 2019 rules. It must come
   * back labelled and carrying a pointer to what replaced it — never bare.
   */
  it('labels a superseded entry and names its replacement', () => {
    const entry = toEntry(legacyDoc, 'spell-119', 'spell');
    expect(entry.canonicity).toBe('legacy');
    expect(entry.supersededBy).toBe('spell-1530');
  });

  it('builds an absolute url from the site-relative one', () => {
    expect(toSummary(currentDoc, 'spell-1530', 'spell').url).toBe(
      'https://2e.aonprd.com/Spells.aspx?ID=1530',
    );
  });

  it('keeps summaries within the size ceiling and free of full body text', () => {
    const long = { ...currentDoc, text: 'x'.repeat(5_000) } as AonDocument;
    const summary = toSummary(long, 'spell-1530', 'spell');
    expect(summary.oneLine.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
  });

  /**
   * No fixture anywhere set `summary`, so every mapping test fell through to the
   * `text` fallback and the branch `oneLineFor` actually prefers went unexercised.
   * A fixture that omits the preferred field tests the wrong path silently.
   */
  it('prefers the summary field over body text for the one-liner', () => {
    const withSummary = {
      ...currentDoc,
      summary: 'A short official summary.',
      text: 'A much longer body that should not be used for the one-liner.',
    } as AonDocument;

    expect(toSummary(withSummary, 'spell-1530', 'spell').oneLine).toBe('A short official summary.');
  });

  it('falls back to body text when there is no summary', () => {
    const noSummary = { ...currentDoc, text: 'Body text only.' } as AonDocument;
    expect(toSummary(noSummary, 'spell-1530', 'spell').oneLine).toBe('Body text only.');
  });

  it('carries source attribution so the reader can see what answered', () => {
    expect(toSummary(currentDoc, 'spell-1530', 'spell').source).toContain('Player Core');
  });
});

/**
 * Every mapper below has a "preferred field, fall back to secondary" shape, and no
 * fixture set any of the preferred fields -- so the fallback was under test while
 * production took the other branch.
 *
 * Confirmed against a live document (spell-1530): summary, source_raw, trait_raw,
 * markdown, rarity and exclude_from_search are all present upstream. These are not
 * hypothetical branches; they are the ones that actually run.
 */
describe('preferred field branches', () => {
  /** Shaped like a real AoN document: every preferred field populated. */
  const realistic = {
    id: 'spell-1530',
    name: 'Fireball',
    type: 'Spell',
    level: 3,
    summary: 'An explosion of fire in an area burns creatures.',
    text: 'Fireball\nTwo Actions. A roaring blast of fire.',
    markdown: '<title level="1">[Fireball](/Spells.aspx?ID=1530)</title>',
    trait: ['concentrate', 'fire', 'manipulate'],
    trait_raw: ['Concentrate', 'Fire', 'Manipulate'],
    source: ['Player Core'],
    source_raw: ['Player Core pg. 331'],
    rarity: 'common',
    url: '/Spells.aspx?ID=1530',
  } as AonDocument;

  it('prefers source_raw, because it carries the page reference', () => {
    const summary = toSummary(realistic, 'spell-1530', 'spell');
    expect(summary.source).toContain('pg. 331');
  });

  it('falls back to source when there is no page reference', () => {
    const noRaw = { ...realistic, source_raw: undefined } as AonDocument;
    expect(toSummary(noRaw, 'spell-1530', 'spell').source).toBe('Player Core');
  });

  /**
   * traitsOf prefers trait_raw for its display casing. With no fixture setting
   * either field it returned [] in every test, so the function was wholly
   * unexercised while production returned real traits.
   */
  it('prefers trait_raw so traits keep their display casing', () => {
    expect(toSummary(realistic, 'spell-1530', 'spell').traits).toEqual([
      'Concentrate',
      'Fire',
      'Manipulate',
    ]);
  });

  it('falls back to the normalized trait field', () => {
    const noRaw = { ...realistic, trait_raw: undefined } as AonDocument;
    expect(toSummary(noRaw, 'spell-1530', 'spell').traits).toEqual([
      'concentrate',
      'fire',
      'manipulate',
    ]);
  });

  /**
   * bodyFor prefers plain text over markdown for a licensing reason: the markdown
   * variant carries AoN link syntax and figure markup, and image content sits
   * outside Paizo's Community Use Policy. Inverting that preference would have
   * been invisible -- no fixture set markdown at all.
   */
  it('prefers plain text over markdown, and returns no markup', () => {
    const entry = toEntry(realistic, 'spell-1530', 'spell');
    expect(entry.body).toContain('roaring blast');
    expect(entry.body).not.toContain('<title');
    expect(entry.body).not.toContain('](/Spells.aspx');
  });

  it('carries rarity through to the entry', () => {
    expect(toEntry(realistic, 'spell-1530', 'spell').rarity).toBe('common');
  });

  /**
   * The client-side half of the canonicity invariant. No fixture set
   * exclude_from_search, so this branch of shouldDropDoc never decided anything --
   * half of a documented correctness guarantee, unexercised.
   */
  it('drops a document AoN itself suppresses, independently of supersession', () => {
    const suppressed = { ...realistic, exclude_from_search: true } as AonDocument;
    expect(isSupersededDoc(suppressed)).toBe(false);
    expect(isExcludedDoc(suppressed)).toBe(true);
    expect(shouldDropDoc(suppressed)).toBe(true);
  });

  it('keeps a document that is neither superseded nor suppressed', () => {
    expect(shouldDropDoc(realistic)).toBe(false);
  });
});

describe('provider declaration', () => {
  const provider = createPf2eProvider({});

  it('declares all sixteen verified categories', () => {
    expect(provider.categories).toHaveLength(16);
    expect(provider.categories.filter((c) => c.tier === 'core')).toHaveLength(8);
    expect(provider.categories.filter((c) => c.tier === 'extended')).toHaveLength(8);
  });

  it('declares capabilities the backend actually provides', () => {
    // Elasticsearch does both server-side; fuzziness comes from the multi_match
    // branch. Claiming 'local' here would understate it, 'none' would be a lie.
    expect(provider.capabilities.fullText).toBe('server');
    expect(provider.capabilities.fuzzy).toBe('server');
    expect(provider.capabilities.semantic).toBe('none');
  });

  it('declares every filter as server-enforced', () => {
    for (const category of provider.categories) {
      for (const filter of category.filters) {
        expect(filter.enforcement).toBe('server');
      }
    }
  });

  it('names the config key that relaxes canonicity', () => {
    expect(provider.canonicityPolicy.relaxedByConfigKey).toBe('INCLUDE_LEGACY');
    expect(provider.configKeys).toContain('INCLUDE_LEGACY');
  });

  it('carries both licence attributions', () => {
    const text = provider.attribution.join(' ');
    expect(text).toMatch(/ORC/i);
    expect(text).toMatch(/Community Use/i);
  });
});

describe('absoluteUrl — upstream data becoming a clickable link', () => {
  it('prefixes a site-relative path', () => {
    expect(absoluteUrl('/Spells.aspx?ID=1530')).toBe('https://2e.aonprd.com/Spells.aspx?ID=1530');
  });

  /**
   * The url field is documented as site-relative. An absolute one is either a
   * schema change or something wrong, and both cases make a link that a person is
   * invited to click as "the source for this rule". No link beats a wrong link.
   */
  it('refuses an absolute url pointing somewhere else', () => {
    expect(absoluteUrl('https://evil.example/x')).toBeUndefined();
    expect(absoluteUrl('//evil.example/x')).toBe('https://2e.aonprd.com//evil.example/x');
  });

  it('allows an absolute url on the expected origin', () => {
    expect(absoluteUrl('https://2e.aonprd.com/Spells.aspx?ID=1')).toBe(
      'https://2e.aonprd.com/Spells.aspx?ID=1',
    );
  });

  it('neutralises a scheme that is not http', () => {
    expect(absoluteUrl('javascript:alert(1)')).toBeUndefined();
  });
});

describe('body cap', () => {
  /**
   * A silently truncated rule is indistinguishable from a short one, and a reader
   * acting on the shortened version has no way to know something is missing.
   */
  it('marks a truncated body rather than cutting it silently', () => {
    const huge = { ...({} as AonDocument), id: 'x-1', name: 'X', type: 'Spell', text: 'y'.repeat(MAX_BODY_CHARS + 500) } as AonDocument;
    const entry = toEntry(huge, 'x-1', 'spell');
    expect(entry.body).toContain('truncated');
    expect(entry.body.length).toBeLessThan(MAX_BODY_CHARS + 200);
  });

  it('leaves a body under the cap untouched', () => {
    const small = { ...({} as AonDocument), id: 'x-2', name: 'Y', type: 'Spell', text: 'short text' } as AonDocument;
    expect(toEntry(small, 'x-2', 'spell').body).toBe('short text');
  });
});
