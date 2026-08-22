import { createRequire } from 'node:module';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };
if (typeof version !== 'string' || version.length === 0) {
  throw new Error('Package metadata must contain a version');
}

/**
 * Single source of truth for every tunable number.
 *
 * Values live here and nowhere else; code and docs reference the name, never the
 * literal. Restating numbers in prose is what caused the same defect class in
 * three consecutive plan revisions -- a value corrected in one place while a stale
 * copy stood elsewhere. A constant referenced by name cannot drift.
 */

/** Default number of search results when the caller does not ask. */
export const DEFAULT_LIMIT = 10;

/** Hard ceiling on results per search. Requests above this are rejected, not clamped. */
export const MAX_LIMIT = 50;

/** Wall-clock deadline for one tool call, measured from handler entry. */
export const TOOL_CALL_BUDGET_MS = 10_000;

/** Ceiling for a single outbound request. Sits inside the tool budget, never beside it. */
export const HTTP_REQUEST_BUDGET_MS = 8_000;

/**
 * Largest upstream response body accepted.
 *
 * `size` bounds how many hits come back, not how many bytes; `_mget` returns full
 * documents with no projection at all. Without a byte cap, a broken or hostile
 * upstream response is fully buffered into memory before anything inspects it, and
 * the request timeout is not a size bound -- on a fast link a lot arrives in eight
 * seconds.
 */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Longest caller-supplied search text accepted. */
export const MAX_QUERY_CHARS = 200;

/** Longest caller-supplied entry id accepted. */
export const MAX_ID_CHARS = 128;

/** Opaque, bounded, process-local search continuations. */
export const MAX_CURSOR_CHARS = 36;
export const CURSOR_TTL_MS = 15 * 60 * 1000;
export const CURSOR_CACHE_ENTRIES = 500;
export const CURSOR_CACHE_BYTES = 1024 * 1024;

/**
 * Ceiling on a full entry body.
 *
 * Summaries are capped, but a details call returns whatever upstream holds, straight
 * into a caller's context. Truncation is marked so a shortened entry is
 * distinguishable from a genuinely short one.
 */
export const MAX_BODY_CHARS = 20_000;

/** Search-result cache: entry count and byte ceiling. Whichever binds first wins. */
export const SEARCH_CACHE_ENTRIES = 500;
export const SEARCH_CACHE_BYTES = 8 * 1024 * 1024;

/** Detail-entry cache. Larger because entries carry full rules text. */
export const DETAIL_CACHE_ENTRIES = 1_000;
export const DETAIL_CACHE_BYTES = 16 * 1024 * 1024;

/** Serialized tool listing ceiling -- clients load this into model context. */
export const MAX_TOOLS_LIST_BYTES = 64 * 1024;

/**
 * Longest closed vocabulary allowed in a filter schema. Small enums teach the
 * caller valid values; large ones bloat the listing. A cap, not a ban.
 */
export const MAX_ENUM_VALUES = 24;

/** Ceiling on a summary's one-line text. */
export const MAX_SUMMARY_CHARS = 300;

/**
 * Minimum spacing between outbound requests.
 *
 * ~4/sec sustained is well above a person clicking through a search UI. It is
 * defensible only because the traffic shape is one or two requests per tool call
 * and never sustained -- not because it matches human browsing, which it does not.
 */
export const THROTTLE_MIN_INTERVAL_MS = 250;

/** Spacing after a 429. Decays back toward the floor so one 429 does not degrade the process for its lifetime. */
export const THROTTLE_429_INTERVAL_MS = 2_000;
export const THROTTLE_DECAY_FACTOR = 0.9;

/** In-flight request ceiling. Two, not one: serializing search-then-details stacks latency for no real politeness gain. */
export const MAX_CONCURRENT_REQUESTS = 2;

/**
 * At or below this many records, a category lists everything on an empty query
 * instead of pretending search is useful. Searching a few dozen closed entries
 * matches everything or nothing; enumerating them is what the reader wants.
 *
 * Deliberately equal to MAX_LIMIT, and it must never exceed it. The affordance is
 * advertised as "omit the query to list every entry", and a category larger than
 * the result ceiling cannot honour that -- it would return a capped page while
 * claiming to be exhaustive. This was set to 60 first, which made PF2e's 56
 * conditions "small" and then returned 50 of them: a promise the limit could not
 * keep. Better to lose the affordance than to advertise it falsely.
 */
export const SMALL_CATEGORY_THRESHOLD = MAX_LIMIT;

export const SERVER_VERSION = version;

/** Identifies this tool to upstream services, with a real contact path. */
export const USER_AGENT = `mcp-rpg-tools/${SERVER_VERSION} (contact: burcinsayin@gmail.com)`;

export const SERVER_NAME = 'rpg-lookup';
