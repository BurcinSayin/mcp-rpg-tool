/**
 * The Archives of Nethys Elasticsearch transport.
 *
 * Every Elasticsearch-shaped decision lives in this file and nowhere else: the
 * request body, the alias binding, the `_source` projection, and the two clauses
 * that decide whether a search is correct or catastrophically wrong. `map.ts`
 * sees documents; `index.ts` sees categories and filters. Neither names an ES
 * concept, which is what keeps the neutral contract in src/provider/types.ts
 * honest.
 *
 * AoN is unowned community infrastructure with no published API contract. Every
 * request therefore goes through the shared HttpClient -- identification,
 * throttling and one shared deadline -- rather than `fetch`.
 */

import { Deadline, type HttpClient } from '../../http.js';
import { BackendError } from '../types.js';

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

const AON_BASE_URL = 'https://elasticsearch.aonprd.com';

/**
 * The ALIAS, never the concrete index.
 *
 * The real index is date-stamped and rotates -- `aon-20260802-141253` was
 * observed live. Binding to a concrete name works right up until AoN reindexes,
 * then fails in production with a 404 that looks like an outage. The alias is
 * the stable name and the only one this file may ever use.
 */
const AON_INDEX_ALIAS = 'aon';

export const AON_SEARCH_URL = `${AON_BASE_URL}/${AON_INDEX_ALIAS}/_search`;
export const AON_MGET_URL = `${AON_BASE_URL}/${AON_INDEX_ALIAS}/_mget`;

// ---------------------------------------------------------------------------
// Query-shape values
//
// Deliberately NOT in src/constants.ts. That file holds cross-cutting tunables
// shared by the whole process; a relevance boost and a should-match threshold
// are Elasticsearch query shape, and hoisting them into shared constants would
// leak backend semantics into code that is meant to know nothing about a
// backend. They are named and commented here, beside the query they shape.
// ---------------------------------------------------------------------------

/**
 * THE most dangerous value in this build. VERIFIED LIVE: with the `should`
 * clauses present but `minimum_should_match` absent, the nonsense query
 * "asdfgh" filtered to type=spell returned 1811 hits -- every spell in the
 * index, led by Abyssal Plague and Air Walk. With it: 0 hits.
 *
 * The reason is that in an ES `bool` that also carries a `filter` clause,
 * `minimum_should_match` defaults to 0, so `should` becomes score-only and stops
 * being required. Every query this provider builds carries a `filter` term on
 * `type`, so the dangerous case is the ONLY case. A search that answers "nothing
 * matched" with the entire category, ranked by an irrelevant score, is a silent
 * wrong answer the reader cannot detect.
 */
const MINIMUM_SHOULD_MATCH = 1;

/**
 * Body text is matched but heavily down-weighted: a spell whose *name* is the
 * query must outrank a spell that merely mentions it in a paragraph.
 */
const TEXT_FIELD_WEIGHT = 0.1;

const MULTI_MATCH_FIELDS: readonly string[] = [
  'name',
  `text^${TEXT_FIELD_WEIGHT}`,
  'trait_raw',
  'type',
];

/** Relevance first, with AoN's sortable stable id as the pagination tiebreak. */
const SORT: readonly string[] = ['_score', 'id.keyword'];

/**
 * Fields that need `match_phrase` rather than `term`, because they are analyzed
 * text rather than keywords.
 *
 * VERIFIED LIVE, and this is not a stylistic choice: `source` holds book titles
 * like "Player Core", and a `term` clause looks for that whole string as a
 * single token. `{"term":{"source":"Player Core"}}` returns 0 -- in any casing,
 * for every book -- while `{"term":{"source":"player"}}` returns 634. A filter
 * that silently matches nothing whatever the caller types is exactly the
 * accepted-and-ignored parameter the schema rules forbid.
 *
 * `match_phrase` in `filter` context stays a hard filter (it excludes, it does
 * not merely score) and is forgiving about the real titles: "Treasure Vault"
 * finds "treasure vault (remastered)", and a book that does not exist returns 0
 * rather than the unfiltered set.
 */
const PHRASE_MATCH_FIELDS: ReadonlySet<string> = new Set(['source']);

function filterClause(field: string, value: string | number | boolean): unknown {
  if (PHRASE_MATCH_FIELDS.has(field)) return { match_phrase: { [field]: value } };
  return { term: { [field]: value } };
}

/**
 * Projection. Only the fields `map.ts` actually reads, because AoN documents are
 * large and a 50-hit search that drags every field over the wire spends the
 * caller's tool budget on bytes nobody maps.
 *
 * Two deliberate omissions:
 *  - `markdown` -- it duplicates `text` with formatting and AoN link syntax, and
 *    the details path fetches the full `_source` anyway.
 *  - image fields -- art was removed from AoN in the July 2026 transition and is
 *    not covered by Paizo's Community Use Policy. This tool never surfaces or
 *    caches images, and not asking for them is the cheapest way to guarantee it.
 */
export const SEARCH_SOURCE_FIELDS: readonly string[] = [
  'id',
  'name',
  'level',
  'type',
  'trait',
  'trait_raw',
  'summary',
  'text',
  'source',
  'source_raw',
  'url',
  'rarity',
  'exclude_from_search',
  'remaster_id',
];

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/**
 * One AoN document's `_source`.
 *
 * Everything is optional and the array-valued fields are typed `string[] |
 * string`: this is unowned upstream data with no schema guarantee, and
 * Elasticsearch itself does not distinguish a single value from a one-element
 * array in `_source`. `map.ts` normalizes rather than trusting.
 */
export interface AonDocument {
  /** e.g. "spell-1530". Filled from the hit's `_id` when `_source.id` is absent. */
  id?: string;
  name?: string;
  level?: number;
  /** Titlecased in `_source` ("Class Feature"); the indexed value is lowercase. */
  type?: string;
  trait?: string[] | string;
  trait_raw?: string[] | string;
  /** Plain body text. */
  text?: string;
  markdown?: string;
  summary?: string;
  source?: string[] | string;
  source_raw?: string[] | string;
  /** Site-relative, e.g. "/Spells.aspx?ID=119". */
  url?: string;
  rarity?: string;
  exclude_from_search?: boolean;
  /** Present ONLY on superseded pre-Remaster documents; points at the replacement. */
  remaster_id?: string[] | string;
}

interface EsSearchHit {
  _id?: string;
  _index?: string;
  _source?: AonDocument;
  sort?: unknown;
}

interface EsSearchResponse {
  hits?: { hits?: unknown };
  timed_out?: unknown;
  _shards?: { failed?: unknown };
}

interface EsMgetResponse {
  docs?: Array<{ _id?: string; found?: boolean; _source?: AonDocument }>;
}

interface EsBoolQuery {
  should?: unknown[];
  minimum_should_match?: number;
  filter: unknown[];
  must_not: unknown[];
}

export interface EsSearchBody {
  query: { bool: EsBoolQuery };
  sort: readonly string[];
  size: number;
  _source: readonly string[] | false;
  search_after?: readonly [number, string];
}

export interface AonSearchRequest {
  /** AoN's own lowercase `type` value, e.g. "spell" or "class feature". */
  aonType: string;
  /** Free text. Absent for a pure-filter or list-all call. */
  text?: string;
  /** One clause per declared filter the caller supplied. Validated upstream. */
  filterValues: Readonly<Record<string, string | number | boolean>>;
  limit: number;
  /** Opaque continuation emitted by the preceding search page. */
  continuation?: string;
  /** Remaining tool-call budget, so the deadline is shared rather than per-hop. */
  budgetMs: number;
  /** Aborts when the caller's overall deadline expires, including while queued. */
  signal?: AbortSignal;
}

export interface AonSearchPage {
  documents: readonly AonDocument[];
  continuation?: string;
}

interface SearchContinuation {
  index: string;
  after: readonly [number, string];
}

// ---------------------------------------------------------------------------
// Body construction
// ---------------------------------------------------------------------------

function unexpectedShape(message: string): BackendError {
  return new BackendError(message, undefined, 'unexpected-shape');
}

function decodeContinuation(continuation: string): SearchContinuation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(continuation);
  } catch {
    throw unexpectedShape('Archives of Nethys returned an invalid search continuation.');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw unexpectedShape('Archives of Nethys returned an invalid search continuation.');
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.index !== 'string' ||
    candidate.index.length === 0 ||
    !Array.isArray(candidate.after) ||
    candidate.after.length !== 2 ||
    typeof candidate.after[0] !== 'number' ||
    !Number.isFinite(candidate.after[0]) ||
    typeof candidate.after[1] !== 'string' ||
    candidate.after[1].length === 0
  ) {
    throw unexpectedShape('Archives of Nethys returned an invalid search continuation.');
  }

  return { index: candidate.index, after: [candidate.after[0], candidate.after[1]] };
}

function validateHits(response: EsSearchResponse): EsSearchHit[] {
  if (typeof response !== 'object' || response === null || Array.isArray(response)) {
    throw unexpectedShape('Archives of Nethys returned a malformed search response.');
  }
  if (response.timed_out === true) {
    throw unexpectedShape('Archives of Nethys timed out while searching.');
  }
  if (typeof response._shards?.failed === 'number' && response._shards.failed > 0) {
    throw unexpectedShape('Archives of Nethys search had failed shards.');
  }

  const hits = response.hits?.hits;
  if (!Array.isArray(hits)) {
    throw unexpectedShape('Archives of Nethys returned a response with no hits section.');
  }
  return hits.map((hit): EsSearchHit => {
    if (typeof hit !== 'object' || hit === null || Array.isArray(hit)) {
      throw unexpectedShape('Archives of Nethys returned a malformed search hit.');
    }
    return hit as EsSearchHit;
  });
}

function hitPosition(hit: EsSearchHit): { index: string; after: readonly [number, string] } {
  if (
    typeof hit._index !== 'string' ||
    hit._index.length === 0 ||
    !Array.isArray(hit.sort) ||
    hit.sort.length !== 2 ||
    typeof hit.sort[0] !== 'number' ||
    !Number.isFinite(hit.sort[0]) ||
    typeof hit.sort[1] !== 'string' ||
    hit.sort[1].length === 0
  ) {
    throw unexpectedShape('Archives of Nethys returned a malformed search hit.');
  }

  return { index: hit._index, after: [hit.sort[0], hit.sort[1]] };
}

export function buildSearchBody(request: AonSearchRequest, includeLegacy: boolean): EsSearchBody {
  const text = request.text?.trim();

  // Mirrors the AoN frontend: an exact-name term and a name prefix match put the
  // thing you literally typed on top, then a fuzzy multi_match so a typo or a
  // description-shaped query still finds something.
  // `name` is analyzed with a lowercase filter, so a term clause only matches a
  // lowercased value: {term:{name:"Fireball"}} returns nothing while "fireball"
  // returns four. Verified live. Left capitalized, this clause silently never
  // fired -- for exactly the queries a caller actually types -- so the exact-name
  // boost it documents did not exist.
  const should: unknown[] = [];
  if (text !== undefined && text.length > 0) {
    should.push(
      { match_phrase_prefix: { 'name.sayt': { query: text } } },
      { term: { name: text.toLowerCase() } },
      {
        multi_match: {
          query: text,
          type: 'best_fields',
          fields: MULTI_MATCH_FIELDS,
          fuzziness: 'auto',
        },
      },
    );
  }

  // The category term is always present; user filters are appended after it.
  // `filter` context, not `must`, because none of these should influence
  // relevance -- they either hold or the document is out.
  const filter: unknown[] = [{ term: { type: request.aonType } }];
  for (const [field, value] of Object.entries(request.filterValues)) {
    filter.push(filterClause(field, value));
  }

  /*
   * Canonicity, enforced server-side.
   *
   * Legacy and Remaster content coexist as separate documents: "Fireball"
   * returns both spell-119 (Core Rulebook, 2019) and spell-1530 (Player Core,
   * 2023). A document carrying `remaster_id` has been SUPERSEDED -- the field is
   * the pointer to what replaced it. Returning 2019 rules as though they were
   * current is the worst failure this server can have, because the text reads
   * perfectly plausibly.
   *
   * `exclude_from_search` is AoN's own suppression flag; respecting it keeps
   * results consistent with what the site itself shows.
   */
  const mustNot: unknown[] = includeLegacy
    ? []
    : [{ exists: { field: 'remaster_id' } }, { term: { exclude_from_search: true } }];

  const bool: EsBoolQuery = { filter, must_not: mustNot };
  if (should.length > 0) {
    bool.should = should;
    // See MINIMUM_SHOULD_MATCH. Set here and only here, and only when there are
    // `should` clauses to require -- a bare filter query legitimately matches
    // everything in its category.
    bool.minimum_should_match = MINIMUM_SHOULD_MATCH;
  }

  const continuation = request.continuation === undefined ? undefined : decodeContinuation(request.continuation);
  return {
    query: { bool },
    sort: SORT,
    size: request.limit + 1,
    _source: SEARCH_SOURCE_FIELDS,
    ...(continuation === undefined ? {} : { search_after: continuation.after }),
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface AonClientOptions {
  /** When true, the canonicity `must_not` is omitted and superseded docs are returned. */
  includeLegacy: boolean;
}

export class AonClient {
  readonly #http: HttpClient;
  readonly #includeLegacy: boolean;

  constructor(http: HttpClient, options: AonClientOptions) {
    this.#http = http;
    this.#includeLegacy = options.includeLegacy;
  }

  async search(request: AonSearchRequest): Promise<AonSearchPage> {
    const deadline = new Deadline(request.budgetMs);
    const previous = request.continuation === undefined ? undefined : decodeContinuation(request.continuation);
    const response = await this.#http.requestJson<EsSearchResponse>({
      url: AON_SEARCH_URL,
      method: 'POST',
      body: buildSearchBody(request, this.#includeLegacy),
      budgetMs: deadline.remainingMs(),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    const hits = validateHits(response);

    let index: string | undefined;
    for (const hit of hits) {
      const position = hitPosition(hit);
      if (index === undefined) index = position.index;
      else if (index !== position.index) {
        throw unexpectedShape('Archives of Nethys returned hits from multiple search indexes.');
      }
    }

    if (previous !== undefined && index !== undefined && index !== previous.index) {
      throw new BackendError(
        'Search index changed; restart the search without cursor.',
        undefined,
        'invalid-cursor',
      );
    }

    if (previous !== undefined && hits.length === 0) {
      const probe = await this.#http.requestJson<EsSearchResponse>({
        url: AON_SEARCH_URL,
        method: 'POST',
        body: { size: 1, query: { match_all: {} }, _source: false },
        budgetMs: deadline.remainingMs(),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const probeHits = validateHits(probe);
      const probeIndex = probeHits[0]?._index;
      if (typeof probeIndex !== 'string' || probeIndex.length === 0 || probeIndex !== previous.index) {
        throw new BackendError(
          'Search index changed; restart the search without cursor.',
          undefined,
          'invalid-cursor',
        );
      }
    }

    const consumed = hits.slice(0, request.limit);
    const documents: AonDocument[] = [];
    for (const hit of consumed) {
      const doc = hit._source;
      if (doc === undefined) continue;
      // `_id` and `_source.id` agree in practice; carrying the fallback here
      // means `_id` -- an ES concept -- never escapes this file.
      documents.push(doc.id === undefined && hit._id !== undefined ? { ...doc, id: hit._id } : doc);
    }

    const last = consumed.at(-1);
    const position = last === undefined ? undefined : hitPosition(last);
    return {
      documents,
      ...(hits.length > request.limit && position !== undefined
        ? { continuation: JSON.stringify({ index: position.index, after: position.after }) }
        : {}),
    };
  }

  /**
   * Fetches one document by id. Returns undefined for "no such document" so the
   * caller can phrase the 404 in terms of its own category.
   *
   * `_mget` bypasses the search query entirely, so the canonicity `must_not`
   * above does NOT apply here: fetching spell-119 directly returns 2019 rules
   * whatever the config says. Labelling that document is `map.ts`'s job and is
   * not optional -- see `canonicityOf`.
   */
  async fetchById(
    id: string,
    budgetMs: number,
    signal?: AbortSignal,
  ): Promise<AonDocument | undefined> {
    const response = await this.#http.requestJson<EsMgetResponse>({
      url: AON_MGET_URL,
      method: 'POST',
      body: { ids: [id] },
      budgetMs,
      ...(signal === undefined ? {} : { signal }),
    });

    const docs = response.docs;
    if (docs === undefined) {
      throw new BackendError(
        'Archives of Nethys returned a response with no docs section.',
        undefined,
        'unexpected-shape',
      );
    }

    const first = docs[0];
    if (first === undefined || first.found !== true) return undefined;

    const doc = first._source;
    if (doc === undefined) return undefined;
    return doc.id === undefined && first._id !== undefined ? { ...doc, id: first._id } : doc;
  }
}
