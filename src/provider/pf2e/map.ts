/**
 * Raw AoN documents in, neutral contract entries out.
 *
 * Pure functions only, no I/O and no query construction. Two reasons this is its
 * own file: the canonicity decision -- the one that decides whether a reader is
 * handed 2019 rules as though they were current -- is small enough to read in
 * one screen and testable without a network, and it is the ONLY place that
 * decision is made, on both the search and the details path.
 */

import { MAX_BODY_CHARS, MAX_SUMMARY_CHARS } from '../../constants.js';
import type { Canonicity, ContentEntry, EntrySummary } from '../types.js';
import type { AonDocument } from './client.js';

/** `_source.url` is site-relative ("/Spells.aspx?ID=119"); readers need a link they can open. */
const AON_SITE_BASE_URL = 'https://2e.aonprd.com';
const AON_SITE_HOSTNAME = new URL(AON_SITE_BASE_URL).hostname;

/** A document can appear in several books. Listing all of them turns a source label into a paragraph. */
const MAX_SOURCES_LISTED = 3;

/**
 * When truncating, only back up to a word boundary if that boundary is at least
 * this far in. Otherwise a summary whose first "word" is very long would be cut
 * to almost nothing.
 */
const MIN_TRUNCATION_KEEP_RATIO = 0.5;

const ELLIPSIS = '…';

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Elasticsearch does not distinguish a single value from a one-element array in
 * `_source`, so a field documented as an array can legitimately arrive as a bare
 * string. Every array-valued read goes through here; nothing indexes a raw field
 * directly.
 */
export function asStringArray(value: string[] | string | undefined): readonly string[] {
  if (value === undefined) return [];
  if (typeof value === 'string') return value.length > 0 ? [value] : [];
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string' && item.length > 0);
}

// ---------------------------------------------------------------------------
// Canonicity
// ---------------------------------------------------------------------------

/**
 * A document carrying `remaster_id` has been replaced by the document that id
 * names. The field is present only on superseded pre-Remaster content, so its
 * presence is the whole test.
 */
export function isSupersededDoc(doc: AonDocument): boolean {
  // Presence, not parseability. Routing through asStringArray meant a
  // remaster_id of an unexpected shape (a number, an object) normalized to []
  // and the document read as current -- while the server-side `exists` filter
  // would still have excluded it, so search and details would disagree about
  // the same document. When in doubt about supersession, say superseded.
  const raw: unknown = doc.remaster_id;
  if (raw === undefined || raw === null) return false;
  if (typeof raw === 'string') return raw.length > 0;
  if (Array.isArray(raw)) return raw.length > 0;
  return true;
}

/** AoN's own suppression flag. Not supersession -- these are simply hidden from site search. */
export function isExcludedDoc(doc: AonDocument): boolean {
  return doc.exclude_from_search === true;
}

/**
 * The client-side defensive drop for SEARCH results.
 *
 * The server-side `must_not` should already have removed these, so in normal
 * operation this never fires. It exists because "should already" is not a
 * guarantee: a fixture recorded before the filter existed, an index whose
 * mapping changed, or a `must_not` clause someone deletes in a refactor would
 * each put superseded rules in front of a reader with nothing to catch them.
 * Two independent mechanisms, both disabled together only by INCLUDE_LEGACY.
 *
 * Deliberately NOT applied to the details path: a document fetched by explicit
 * id is returned, labelled `legacy` and carrying its forward pointer, rather
 * than hidden. Refusing to answer is worse than answering with the label.
 */
export function shouldDropDoc(doc: AonDocument): boolean {
  return isSupersededDoc(doc) || isExcludedDoc(doc);
}

/**
 * 'legacy' vs 'current' -- the two states AoN's data can actually distinguish.
 *
 * 'third-party' and 'unknown' are never produced here: AoN hosts only Paizo
 * content, and under the Remaster model a document with no `remaster_id` is
 * current by definition (untouched content carries neither pointer). Returning
 * 'unknown' for those would be a hedge that reads as doubt where there is none.
 */
export function canonicityOf(doc: AonDocument): Canonicity {
  return isSupersededDoc(doc) ? 'legacy' : 'current';
}

/** The id of the document that replaced this one. Set whenever canonicity is 'legacy'. */
export function supersededByOf(doc: AonDocument): string | undefined {
  return asStringArray(doc.remaster_id)[0];
}

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------

/**
 * Turns the site-relative `url` field into a link.
 *
 * This is the one place upstream data becomes *actionable* rather than merely
 * readable: the result is surfaced to a person as "the source for this rule", so
 * an arbitrary absolute URL here is a link someone is invited to click. The field
 * is documented as site-relative, so an absolute one is either a schema change or
 * something wrong — and in both cases the honest answer is no link at all.
 *
 * The prefixing branch is inherently safe (`javascript:alert(1)` becomes
 * `https://2e.aonprd.com/javascript:alert(1)`, which is inert), but an absolute
 * value would pass through untouched, so it is checked against the expected origin
 * rather than trusted.
 */
export function absoluteUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const trimmed = url.trim();
  if (trimmed.length === 0) return undefined;

  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    try {
      // Same-origin only. No link beats a link somewhere else.
      const parsed = new URL(trimmed);
      if (parsed.hostname === AON_SITE_HOSTNAME) {
        parsed.protocol = 'https:';
        return parsed.toString();
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  return `${AON_SITE_BASE_URL}${trimmed.startsWith('/') ? '' : '/'}${trimmed}`;
}

/**
 * Prefers `source_raw` because it carries the page reference ("Player Core pg.
 * 322") -- the reader wants to know exactly what answered, not just which book.
 */
export function sourceLabel(doc: AonDocument): string | undefined {
  const raw = asStringArray(doc.source_raw);
  const list = raw.length > 0 ? raw : asStringArray(doc.source);
  if (list.length === 0) return undefined;
  return list.slice(0, MAX_SOURCES_LISTED).join('; ');
}

/** `trait_raw` keeps the display casing ("Fire"); `trait` is the normalized index value. */
export function traitsOf(doc: AonDocument): readonly string[] {
  const raw = asStringArray(doc.trait_raw);
  return raw.length > 0 ? raw : asStringArray(doc.trait);
}

/**
 * One line, capped at MAX_SUMMARY_CHARS.
 *
 * `summary` is AoN's own short description and is what the reader wants; a
 * trimmed `text` is the fallback for the documents that have none. The cap is
 * the mechanism that keeps a summary from becoming a body: a search result set
 * carrying full rules text is what the details tools exist to prevent.
 */
export function oneLineFor(doc: AonDocument): string {
  const summary = collapseWhitespace(doc.summary ?? '');
  const candidate = summary.length > 0 ? summary : collapseWhitespace(doc.text ?? '');
  return truncate(candidate, MAX_SUMMARY_CHARS);
}

/**
 * Full body text.
 *
 * Plain `text` is preferred over `markdown` on purpose: the markdown variant
 * carries AoN link syntax and figure markup, and image content is outside
 * Paizo's Community Use Policy. Plain text cannot smuggle either.
 */
export function bodyFor(doc: AonDocument): string {
  const text = doc.text?.trim();
  const markdown = doc.markdown?.trim();
  const chosen =
    text !== undefined && text.length > 0
      ? text
      : markdown !== undefined && markdown.length > 0
        ? markdown
        : (doc.summary?.trim() ?? '');

  // Capped, and the cap is announced. An entry silently cut off would read as a
  // rule that simply ends, which is indistinguishable from a short rule -- and a
  // reader acting on a truncated rule has no way to know something is missing.
  if (chosen.length <= MAX_BODY_CHARS) return chosen;
  const marker = `\n\n[truncated at ${MAX_BODY_CHARS} characters]`;
  return `${chosen.slice(0, MAX_BODY_CHARS - marker.length)}${marker}`;
}

// ---------------------------------------------------------------------------
// Entry construction
//
// `id` is passed in rather than read from the document: the caller has already
// resolved it (and rejected documents that have none), so neither of these can
// produce an entry whose id will not round-trip to a details call.
// ---------------------------------------------------------------------------

export function toSummary(doc: AonDocument, id: string, categoryKey: string): EntrySummary {
  const traits = traitsOf(doc);
  const source = sourceLabel(doc);
  const url = absoluteUrl(doc.url);

  return {
    id,
    name: doc.name ?? id,
    categoryKey,
    ...(typeof doc.level === 'number' ? { level: doc.level } : {}),
    ...(traits.length > 0 ? { traits } : {}),
    oneLine: oneLineFor(doc),
    canonicity: canonicityOf(doc),
    ...(source === undefined ? {} : { source }),
    ...(url === undefined ? {} : { url }),
  };
}

export function toEntry(doc: AonDocument, id: string, categoryKey: string): ContentEntry {
  const traits = traitsOf(doc);
  const source = sourceLabel(doc);
  const url = absoluteUrl(doc.url);
  const canonicity = canonicityOf(doc);
  // Set together with the label, never separately: a 'legacy' entry without the
  // forward pointer tells the reader their answer is stale but not what replaced
  // it, which is the failure mode only half-fixed.
  const supersededBy = canonicity === 'legacy' ? supersededByOf(doc) : undefined;

  return {
    id,
    name: doc.name ?? id,
    categoryKey,
    ...(typeof doc.level === 'number' ? { level: doc.level } : {}),
    ...(traits.length > 0 ? { traits } : {}),
    body: bodyFor(doc),
    canonicity,
    ...(supersededBy === undefined ? {} : { supersededBy }),
    ...(source === undefined ? {} : { source }),
    ...(url === undefined ? {} : { url }),
    ...(doc.rarity === undefined ? {} : { rarity: doc.rarity }),
  };
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  // -1 leaves room for the ellipsis, so the result is never longer than the cap.
  const cut = value.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const kept = lastSpace > max * MIN_TRUNCATION_KEEP_RATIO ? cut.slice(0, lastSpace) : cut;
  return `${kept.trimEnd()}${ELLIPSIS}`;
}
