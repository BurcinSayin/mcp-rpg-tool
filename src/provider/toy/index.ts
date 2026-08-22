/**
 * A tiny in-memory provider that exists to keep the contract honest.
 *
 * With only one real backend shipping, this is the primary check that
 * src/provider/types.ts stayed backend-neutral. If the contract ever acquires an
 * Elasticsearch-shaped concept -- a raw query clause, a `_source` projection, a
 * relevance score no other backend can produce -- this file becomes awkward or
 * impossible to write, and the build fails. That is a semantics check; an
 * identifier denylist would only be a spelling check, and the real leak would
 * never be named `MustNotClause`.
 *
 * What it does NOT validate, and must not be claimed to: schema diversity,
 * capability variance against a genuinely foreign backend, or pagination and
 * relevance semantics that differ from Elasticsearch. Those return with a second
 * real provider. This is a neutrality check, not a substitute for one.
 *
 * It also gives the two-provider acceptance checks something real to run against:
 * differing category sets, and two servers in one client without name collision.
 */

import { MAX_SUMMARY_CHARS } from '../../constants.js';
import { searchCacheKey } from '../../cache.js';
import { SearchCursorStore } from '../../pagination.js';
import type {
  CategoryDescriptor,
  ContentEntry,
  EntrySummary,
  ProviderFactory,
  SearchQuery,
  SearchResult,
  SystemProvider,
} from '../types.js';
import { BackendError } from '../types.js';

interface ToyRecord {
  id: string;
  name: string;
  categoryKey: string;
  level?: number;
  traits?: string[];
  body: string;
}

const RECORDS: readonly ToyRecord[] = [
  { id: 'widget-1', name: 'Brass Widget', categoryKey: 'widget', level: 1, traits: ['metal'], body: 'A small brass widget. Turns clockwise.' },
  { id: 'widget-2', name: 'Copper Widget', categoryKey: 'widget', level: 2, traits: ['metal'], body: 'A copper widget. Conducts heat well.' },
  { id: 'widget-3', name: 'Wooden Widget', categoryKey: 'widget', level: 1, traits: ['wood'], body: 'Buoyant, and shaped from oak.' },
  { id: 'widget-4', name: 'Glass Widget', categoryKey: 'widget', level: 3, traits: ['fragile'], body: 'A glass widget. Handle with care.' },
  { id: 'widget-5', name: 'Iron Widget', categoryKey: 'widget', level: 4, traits: ['metal', 'heavy'], body: 'An iron widget. Notably heavy.' },
  { id: 'widget-6', name: 'Silver Widget', categoryKey: 'widget', level: 5, traits: ['metal', 'precious'], body: 'A silver widget. Tarnishes slowly.' },
  { id: 'widget-7', name: 'Clay Widget', categoryKey: 'widget', level: 1, traits: ['fragile'], body: 'A clay widget. Unfired.' },
  { id: 'widget-8', name: 'Steel Widget', categoryKey: 'widget', level: 6, traits: ['metal'], body: 'A steel widget. Holds an edge.' },
  { id: 'widget-9', name: 'Paper Widget', categoryKey: 'widget', level: 0, traits: ['light'], body: 'A paper widget. Mostly decorative.' },
  { id: 'widget-10', name: 'Stone Widget', categoryKey: 'widget', level: 3, traits: ['heavy'], body: 'A stone widget. Very durable.' },
  { id: 'widget-11', name: 'Tin Widget', categoryKey: 'widget', level: 2, traits: ['metal'], body: 'A tin widget. Light for its size.' },
  { id: 'widget-12', name: 'Bone Widget', categoryKey: 'widget', level: 4, traits: ['fragile'], body: 'A bone widget. Yellowed with age.' },
  { id: 'widget-13', name: 'Jade Widget', categoryKey: 'widget', level: 7, traits: ['precious'], body: 'A jade widget. Cool to the touch.' },
  { id: 'widget-14', name: 'Lead Widget', categoryKey: 'widget', level: 5, traits: ['metal', 'heavy'], body: 'A lead widget. Dense and dull.' },
  { id: 'gizmo-1', name: 'Spinning Gizmo', categoryKey: 'gizmo', traits: ['kinetic'], body: 'A gizmo that spins continuously.' },
  { id: 'gizmo-2', name: 'Humming Gizmo', categoryKey: 'gizmo', traits: ['sonic'], body: 'Emits a low continuous drone.' },
  { id: 'gizmo-3', name: 'Blinking Gizmo', categoryKey: 'gizmo', traits: ['light'], body: 'A gizmo that blinks intermittently.' },
  { id: 'gizmo-4', name: 'Silent Gizmo', categoryKey: 'gizmo', traits: [], body: 'A gizmo that does nothing observable.' },
  { id: 'gizmo-5', name: 'Warm Gizmo', categoryKey: 'gizmo', traits: ['thermal'], body: 'A gizmo that is faintly warm.' },
  { id: 'gizmo-6', name: 'Heavy Gizmo', categoryKey: 'gizmo', traits: ['heavy'], body: 'A gizmo that is surprisingly heavy.' },
  { id: 'note-1', name: 'Assembly Note', categoryKey: 'note', body: 'Widgets attach to gizmos with a quarter turn.' },
  { id: 'note-2', name: 'Safety Note', categoryKey: 'note', body: 'Do not submerge a paper widget.' },
  { id: 'note-3', name: 'Storage Note', categoryKey: 'note', body: 'Store fragile widgets separately.' },
  { id: 'note-4', name: 'Disposal Note', categoryKey: 'note', body: 'Return metal widgets for recycling.' },
  // Deliberately past MAX_SUMMARY_CHARS: without it nothing exercises the summary
  // cap, and the missing truncation above shipped unnoticed.
  { id: 'note-5', name: 'Long Note', categoryKey: 'note', body: 'Overlong note. ' + 'Repeated filler text. '.repeat(40) },
];

const CATEGORIES: readonly CategoryDescriptor[] = [
  {
    key: 'widget',
    displayName: 'Widget',
    description: 'Test widgets. Exists to prove the contract is backend-neutral.',
    tier: 'core',
    filters: [
      { name: 'level', valueType: 'integer', description: 'Exact level.', enforcement: 'client', minimum: 0, maximum: 10 },
      { name: 'trait', valueType: 'string', description: 'A trait the widget carries.', enforcement: 'client' },
    ],
    // Deliberately above DEFAULT_LIMIT: at exactly ten this category could not
    // distinguish "listed every entry" from "returned one default page", so a
    // list-all assertion on it proved nothing.
    approximateSize: 14,
    smallClosedSet: true,
  },
  {
    key: 'gizmo',
    displayName: 'Gizmo',
    description: 'Test gizmos. Deliberately has no level filter, so category filter sets differ.',
    tier: 'core',
    filters: [
      { name: 'trait', valueType: 'string', description: 'A trait the gizmo carries.', enforcement: 'client' },
    ],
    approximateSize: 6,
    smallClosedSet: true,
  },
  {
    key: 'note',
    displayName: 'Note',
    description: 'Test notes. No filters at all.',
    tier: 'extended',
    filters: [],
    approximateSize: 5,
    smallClosedSet: true,
  },
];

export const TOY_CONFIG_KEYS = ['TOY_INCLUDE_RETIRED', 'TOY_INCLUDE_EXTENDED'] as const;

class ToyProvider implements SystemProvider {
  readonly key = 'toy';
  readonly displayName = 'Toy Test System';
  // Honest declaration: matching here is done in this file, over records already in
  // hand. It is local, not server-side, and nothing pretends otherwise.
  readonly capabilities = { fullText: 'local', fuzzy: 'none', semantic: 'none' } as const;
  readonly categories: readonly CategoryDescriptor[];
  readonly canonicityPolicy = {
    description: 'Toy records are all current; there is no superseded content.',
    relaxedByConfigKey: 'TOY_INCLUDE_RETIRED',
  };
  // TOY_INCLUDE_EXTENDED is declared because config resolves the extended-tier
  // flag only from keys the ACTIVE provider claims. Without it this provider's
  // `extended` category was unreachable -- declared, never registrable, and
  // nothing noticed until a test tried to call it.
  readonly configKeys = TOY_CONFIG_KEYS;
  readonly attribution = ['Toy provider: synthetic test data, no external content.'] as const;
  /**
   * Deliberately an EXTENDED category. With the extended tier off it is not
   * registered, so the description layer must suppress the suggestion rather
   * than point at a tool that does not exist. pf2e cannot exercise this -- its
   * fallback is core and always present.
   */
  readonly fallbackCategoryKey = 'note';
  readonly #cursors = new SearchCursorStore<number>();

  constructor(bloat: boolean = false) {
    if (bloat) {
      const bloatCategories: CategoryDescriptor[] = [];
      for (let i = 0; i < 200; i++) {
        bloatCategories.push({
          key: `bloat_${i}`,
          displayName: `Bloat ${i}`,
          description: 'A very long string to bloat the tools list. '.repeat(10),
          tier: 'core',
          filters: [],
          approximateSize: 1,
          smallClosedSet: true,
        });
      }
      this.categories = [...CATEGORIES, ...bloatCategories];
    } else {
      this.categories = CATEGORIES;
    }
  }

  async search(category: CategoryDescriptor, query: SearchQuery): Promise<SearchResult> {
    let rows = RECORDS.filter((r) => r.categoryKey === category.key);

    const level = query.filters['level'];
    if (level !== undefined) rows = rows.filter((r) => r.level === Number(level));

    const trait = query.filters['trait'];
    if (trait !== undefined) {
      rows = rows.filter((r) => (r.traits ?? []).includes(String(trait)));
    }

    const text = query.query?.trim().toLowerCase();
    if (text) {
      // A no-match returns nothing. Returning the unfiltered set because the query
      // matched nothing is the failure this whole design guards against.
      rows = rows.filter(
        (r) => r.name.toLowerCase().includes(text) || r.body.toLowerCase().includes(text),
      );
    }

    const normalizedText = query.query?.trim();
    const context = searchCacheKey(this.key, category.key, {
      ...(normalizedText ? { query: normalizedText } : {}),
      filters: query.filters,
      limit: query.limit,
    }, 'toy-records-v1');
    const state = query.cursor === undefined ? undefined : this.#cursors.read(query.cursor, context);
    const offset = state?.position ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > rows.length) {
      throw new BackendError('Invalid or expired cursor; restart the search without cursor.', undefined, 'invalid-cursor');
    }
    const end = offset + query.limit;
    return {
      entries: rows.slice(offset, end).map(toSummary),
      ...(end < rows.length ? { nextCursor: this.#cursors.issue(context, end, state?.expiresAt) } : {}),
    };
  }

  getDetails(category: CategoryDescriptor, id: string): Promise<ContentEntry> {
    const row = RECORDS.find((r) => r.id === id && r.categoryKey === category.key);
    if (row === undefined) {
      return Promise.reject(new BackendError(`No ${category.displayName} with id "${id}".`, 404));
    }
    return Promise.resolve({
      id: row.id,
      name: row.name,
      categoryKey: row.categoryKey,
      ...(row.level === undefined ? {} : { level: row.level }),
      ...(row.traits === undefined ? {} : { traits: row.traits }),
      body: row.body,
      canonicity: 'current',
      source: 'Toy Reference',
    });
  }
}

function toSummary(row: ToyRecord): EntrySummary {
  return {
    id: row.id,
    name: row.name,
    categoryKey: row.categoryKey,
    ...(row.level === undefined ? {} : { level: row.level }),
    ...(row.traits === undefined ? {} : { traits: row.traits }),
    // Capped, like the real provider's mapper. Without this a record whose body
    // exceeds MAX_SUMMARY_CHARS fails the tool's own output-schema validation at
    // runtime -- the schema declares the ceiling and the SDK enforces it. Every
    // fixture body happened to be short, so the omission never fired.
    oneLine:
      row.body.length <= MAX_SUMMARY_CHARS
        ? row.body
        : `${row.body.slice(0, MAX_SUMMARY_CHARS - 1)}…`,
    canonicity: 'current',
    source: 'Toy Reference',
  };
}

/** No I/O: the server must be able to start and list tools with no network at all. */
export const createToyProvider: ProviderFactory = (env) => new ToyProvider(env?.['TOY_BLOAT_TOOLS'] === 'true');
