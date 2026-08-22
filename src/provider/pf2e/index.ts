/**
 * The Pathfinder 2e provider, backed by Archives of Nethys.
 *
 * This file owns everything that is a PF2e concept rather than an Elasticsearch
 * one: which categories exist, what each may be filtered by, how a slug maps to
 * AoN's own `type` value, and the two caches. The ES request shape lives in
 * `client.ts`; document-to-entry mapping lives in `map.ts`.
 *
 * Three things here are correctness, not polish:
 *
 *  1. `minimum_should_match: 1` on every text query (client.ts). Without it a
 *     nonsense query returns the entire category.
 *  2. Remaster filtering by default, server-side (client.ts) AND client-side
 *     (`shouldDropDoc`), disabled together only by INCLUDE_LEGACY.
 *  3. The details path labels what the search path hides. `_mget` bypasses the
 *     query, so a legacy id fetched directly returns 2019 rules; it comes back
 *     marked `legacy` with a pointer to what replaced it, never unlabelled.
 *
 * Construction performs NO I/O. The server must start, list every tool and
 * describe every filter with the network entirely unavailable; a provider that
 * probed the backend to count a category would make the tool listing depend on
 * an unowned third party being up.
 */

import { BoundedCache, detailCacheKey, searchCacheKey } from '../../cache.js';
import {
  DETAIL_CACHE_BYTES,
  DETAIL_CACHE_ENTRIES,
  MAX_LIMIT,
  SEARCH_CACHE_BYTES,
  SEARCH_CACHE_ENTRIES,
  SMALL_CATEGORY_THRESHOLD,
  TOOL_CALL_BUDGET_MS,
} from '../../constants.js';
import { Deadline, HttpClient } from '../../http.js';
import { SearchCursorStore } from '../../pagination.js';
import type {
  CategoryDescriptor,
  CategoryTier,
  ContentEntry,
  EntrySummary,
  FilterField,
  ProviderFactory,
  SearchQuery,
  SearchResult,
  SystemProvider,
} from '../types.js';
import { BackendError } from '../types.js';
import { AonClient } from './client.js';
import { shouldDropDoc, toEntry, toSummary } from './map.js';

const SYSTEM_KEY = 'pf2e';

/** Relaxes the Remaster filter on both the request and the client-side drop. */
const INCLUDE_LEGACY_KEY = 'INCLUDE_LEGACY';

/**
 * Narrows the tool listing to the eight core categories when set false. Declared
 * so that config validation knows this provider owns the key -- it is applied by
 * the server when it chooses which tiers to register, not here. See `categories`
 * in the constructor.
 */
const INCLUDE_EXTENDED_KEY = 'PF2E_INCLUDE_EXTENDED';

export const PF2E_CONFIG_KEYS = [INCLUDE_LEGACY_KEY, INCLUDE_EXTENDED_KEY] as const;

// ---------------------------------------------------------------------------
// Filters
//
// Every filter here is `enforcement: 'server'`: each is a real indexed AoN field
// applied as a clause the backend actually honours, so a value that cannot match
// returns zero rather than the unfiltered set.
//
// Which filters appear on which category was measured, not guessed. A field
// aggregation over the live index under the Remaster filter gave per-category
// coverage, and two rules follow from it:
//
//   - A field absent from a category is not declared there. `trait` is populated
//     on 0% of conditions, 0% of class features, 5% of heritages and 7% of
//     deities; declaring it would offer a filter that answers nothing.
//   - A field with one value across a category is not declared there either.
//     Every condition, trait, deity, class feature and source is rarity
//     "common", so a rarity filter would cost tool-listing bytes and a wasted
//     call to narrow nothing.
//
// The consequence is that categories carry between zero and four filters rather
// than a uniform set. That asymmetry is the data being honest about itself.
// ---------------------------------------------------------------------------

/**
 * Small enough to be an asset: four values teach the caller the vocabulary and
 * stop malformed input, and it sits far below MAX_ENUM_VALUES.
 */
const RARITY_VALUES: readonly string[] = ['common', 'uncommon', 'rare', 'unique'];

/**
 * No enum, deliberately. PF2e has 564 traits -- far past MAX_ENUM_VALUES -- and
 * an enum that long would bloat the tool listing every client loads into model
 * context. A described free string is the honest trade.
 */
const TRAIT_FILTER: FilterField = {
  name: 'trait',
  valueType: 'string',
  description:
    'A single trait, e.g. "fire", "goblin", "concentrate". Matches entries carrying that trait. One trait per search.',
  enforcement: 'server',
};

const RARITY_FILTER: FilterField = {
  name: 'rarity',
  valueType: 'string',
  description: 'Availability rarity. Most content is common; uncommon and rarer usually needs access.',
  enforcement: 'server',
  enumValues: RARITY_VALUES,
};

const TRADITION_VALUES: readonly string[] = ['arcane', 'divine', 'occult', 'primal'];

const TRADITION_FILTER: FilterField = {
  name: 'tradition',
  valueType: 'string',
  description: 'Magical tradition. Matches spells belonging to this tradition.',
  enforcement: 'server',
  enumValues: TRADITION_VALUES,
};

function levelFilter(minimum: number, maximum: number, description: string): FilterField {
  return {
    name: 'level',
    valueType: 'integer',
    description,
    enforcement: 'server',
    minimum,
    maximum,
  };
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

interface Pf2eCategory {
  /** Tool-name-safe slug. Differs from `aonType` wherever AoN's value has a space. */
  key: string;
  /** AoN's own lowercase `type` value, used verbatim as the ES term. */
  aonType: string;
  displayName: string;
  description: string;
  tier: CategoryTier;
  filters: readonly FilterField[];
  /**
   * Live count under the Remaster filter, observed 2026-08. A static snapshot,
   * because deriving it would mean querying at construction time. It exists to
   * decide `smallClosedSet` against SMALL_CATEGORY_THRESHOLD without hardcoding
   * that judgement per category, and to record that every declared category was
   * verified non-empty -- shipping a tool over an empty category is a defect
   * that only a count catches.
   */
  count: number;
}

/**
 * Routing guidance, per category.
 *
 * Lives here rather than in the shared tool layer because it is Pathfinder
 * ontology: only this provider knows that Demoralize is an action rather than a
 * feat. A shared module encoding it would be one game's rules applied to every
 * game -- which is how a toy-system tool description ended up pointing at a
 * `toy_search_rules` tool that does not exist.
 */
const ROUTING: Readonly<Record<string, { examples?: readonly string[]; notFor?: string }>> = {
  spell: {
    examples: ['what does Fireball do', '3rd-rank fire spells', 'Force Barrage'],
    notFor: 'For a class ability that is not a spell, use the feat or class-feature tool.',
  },
  feat: {
    examples: ['1st-level Fighter class feats', 'Vicious Swing', 'skill feats for Athletics'],
    notFor:
      'For a named combat maneuver like Demoralize or Trip, use the action tool — those are actions, not feats.',
  },
  creature: {
    examples: ['Goblin Warrior stats', 'level 5 undead', 'dragon statblocks'],
    notFor: 'For a trap or environmental danger, use the hazard tool.',
  },
  item: {
    examples: ['longsword price and bulk', 'healing potion', "adventurer's kit contents"],
    notFor:
      'Broad catch-all for gear. For a spell-like consumable effect, check the spell tool as well.',
  },
  action: {
    examples: ['how does Demoralize work', 'Trip', 'Raise a Shield', 'Grapple'],
    notFor:
      'Named maneuvers live here, not under feats. For general turn structure, use the rules tool.',
  },
  condition: {
    examples: ['what does Grabbed do', 'Frightened', 'Clumsy'],
  },
  trait: {
    examples: ['what does the Flourish trait mean', 'Concentrate', 'Manipulate'],
    notFor: 'Traits are keywords attached to other entries, not abilities in their own right.',
  },
  rules: {
    examples: ['how do critical hits work', 'rules for falling', 'how does concealment work'],
    notFor: 'The general fallback. If no other category fits the question, use this one.',
  },
  hazard: { examples: ['poison dart trap', 'level 3 hazards', 'haunt'] },
  deity: { examples: ['Sarenrae', 'deities with the fire domain'] },
  background: { examples: ['Acolyte background', 'backgrounds granting Athletics'] },
  heritage: { examples: ['Elf heritages', 'Versatile Heritage options'] },
  archetype: { examples: ['Bastion archetype', 'multiclass archetypes'] },
  'class-feature': {
    examples: ['Fighter class features by level', "Rogue's Sneak Attack"],
    notFor: 'For an optional choice you spend a feat on, use the feat tool.',
  },
  ritual: { examples: ['Resurrect ritual', 'rituals of 4th rank'] },
  source: {
    examples: ['Player Core', 'what book is this from'],
    notFor: 'Metadata about rulebooks, not the rules themselves.',
  },
};

const CATEGORY_TABLE: readonly Pf2eCategory[] = [
  // --- Core -----------------------------------------------------------------
  {
    key: 'spell',
    aonType: 'spell',
    displayName: 'Spell',
    description:
      'Spells and cantrips of every tradition -- arcane, divine, occult, primal -- with their ranks, traits and effects.',
    tier: 'core',
    filters: [
      // 1, not 0: AoN indexes cantrips at rank 1, so a level-0 search would be
      // accepted and return nothing. The bounds on every level filter here are
      // the observed min and max for that category, because schema validation
      // rejects out-of-range values -- a clear "must be at most 10" beats an
      // empty result that reads as "no such spell exists".
      levelFilter(1, 10, 'Spell rank, 1 through 10. Cantrips are indexed at rank 1.'),
      TRAIT_FILTER,
      RARITY_FILTER,
      TRADITION_FILTER,
    ],
    count: 1811,
  },
  {
    key: 'feat',
    aonType: 'feat',
    displayName: 'Feat',
    description:
      'Ancestry, class, skill, general and archetype feats, with their level, prerequisites and effects.',
    tier: 'core',
    filters: [
      levelFilter(1, 20, 'Character level at which the feat becomes available.'),
      TRAIT_FILTER,
      RARITY_FILTER,
    ],
    count: 6296,
  },
  {
    key: 'creature',
    aonType: 'creature',
    displayName: 'Creature',
    description:
      'Monsters and NPCs with their level, traits and stat blocks.',
    tier: 'core',
    filters: [
      levelFilter(-1, 25, 'Creature level, from -1 for the weakest through 25.'),
      TRAIT_FILTER,
      RARITY_FILTER,
    ],
    count: 3743,
  },
  {
    key: 'item',
    aonType: 'item',
    displayName: 'Item',
    description:
      'Equipment, weapons, armour, consumables and magic items, with their level, price and effects.',
    tier: 'core',
    filters: [
      levelFilter(-1, 28, 'Item level, which sets its price band and availability.'),
      TRAIT_FILTER,
      RARITY_FILTER,
    ],
    count: 7795,
  },
  {
    key: 'action',
    aonType: 'action',
    displayName: 'Action',
    description:
      'Basic and specialty actions and activities -- what a character can do on their turn, and what it costs.',
    tier: 'core',
    filters: [TRAIT_FILTER, RARITY_FILTER],
    count: 551,
  },
  {
    key: 'condition',
    aonType: 'condition',
    displayName: 'Condition',
    // No "small closed set" note here: the tool description builder adds that
    // line for any category whose smallClosedSet is true, and saying it twice in
    // one description reads as a stutter.
    description:
      'Conditions such as frightened, clumsy or grabbed, and exactly what each one does.',
    tier: 'core',
    // No trait (0% of conditions carry one) and no rarity (all 56 are common).
    filters: [],
    count: 56,
  },
  {
    key: 'trait',
    aonType: 'trait',
    displayName: 'Trait',
    description:
      'Trait definitions -- what carrying a given trait means mechanically, for creatures, items, spells and actions alike.',
    tier: 'core',
    // All 564 trait entries are rarity "common", so a rarity filter here would
    // narrow nothing.
    filters: [],
    count: 564,
  },
  {
    key: 'rules',
    aonType: 'rules',
    displayName: 'Rule',
    description:
      'Rules text from the rulebooks: subsystems, procedures and general play rules that are not a spell, feat, item or action.',
    tier: 'core',
    filters: [],
    count: 2358,
  },

  // --- Extended -------------------------------------------------------------
  {
    key: 'hazard',
    aonType: 'hazard',
    displayName: 'Hazard',
    description: 'Traps, environmental dangers and haunts, with their level, disable DCs and effects.',
    tier: 'extended',
    filters: [
      levelFilter(-1, 23, 'Hazard level, used the same way as a creature level for encounter budgeting.'),
      TRAIT_FILTER,
      RARITY_FILTER,
    ],
    count: 553,
  },
  {
    key: 'deity',
    aonType: 'deity',
    displayName: 'Deity',
    description:
      'Gods, philosophies and other divine patrons, with their edicts, anathema, domains and cleric spells.',
    tier: 'extended',
    // Only 7% of deities carry a trait and all 484 are rarity "common".
    filters: [],
    count: 484,
  },
  {
    key: 'background',
    aonType: 'background',
    displayName: 'Background',
    description: 'Character backgrounds and the attribute boosts, skills and feat each one grants.',
    tier: 'extended',
    filters: [TRAIT_FILTER, RARITY_FILTER],
    count: 518,
  },
  {
    key: 'heritage',
    aonType: 'heritage',
    displayName: 'Heritage',
    description: 'Ancestry heritages and the abilities each one grants at character creation.',
    tier: 'extended',
    // Trait is populated on 5% of heritages, so it is not offered.
    filters: [RARITY_FILTER],
    count: 308,
  },
  {
    key: 'archetype',
    aonType: 'archetype',
    displayName: 'Archetype',
    description:
      'Archetypes: their dedication feat, prerequisites and the feats they open up through multiclassing or training.',
    tier: 'extended',
    filters: [TRAIT_FILTER, RARITY_FILTER],
    count: 248,
  },
  {
    // AoN's type value carries a space; tool names cannot. The slug is the
    // hyphenated form and the mapping between them lives only in this table.
    key: 'class-feature',
    aonType: 'class feature',
    displayName: 'Class Feature',
    description:
      'Class features granted automatically by level -- subclasses, proficiency increases and signature abilities.',
    tier: 'extended',
    // No trait (0% coverage) and no rarity (all 774 are common).
    filters: [levelFilter(1, 19, 'Class level at which the feature is granted.')],
    count: 774,
  },
  {
    key: 'ritual',
    aonType: 'ritual',
    displayName: 'Ritual',
    description:
      'Rituals: long-form magic anyone can attempt, with their rank, cost, secondary casters and checks.',
    tier: 'extended',
    filters: [
      levelFilter(1, 10, 'Ritual rank.'),
      TRAIT_FILTER,
      RARITY_FILTER,
    ],
    count: 162,
  },
  {
    key: 'source',
    aonType: 'source',
    displayName: 'Source',
    description:
      'The books and products themselves -- release information and what each one contains. Use this to find out what a book is, not what is in it.',
    tier: 'extended',
    // No filters: a book has no level, traits or rarity of its own, and
    // filtering sources by source is circular.
    filters: [],
    count: 252,
  },
];

function toDescriptor(category: Pf2eCategory): CategoryDescriptor {
  return {
    key: category.key,
    displayName: category.displayName,
    description: category.description,
    tier: category.tier,
    filters: category.filters,
    ...(ROUTING[category.key] === undefined ? {} : { routing: ROUTING[category.key] }),
    approximateSize: category.count,
    // Derived from the static snapshot, never queried. No PF2e category currently
    // qualifies: the smallest is `condition` at 56, above SMALL_CATEGORY_THRESHOLD
    // (which is tied to MAX_LIMIT, since a set larger than one page cannot be
    // listed wholesale however small it feels).
    smallClosedSet: category.count <= SMALL_CATEGORY_THRESHOLD,
  };
}

/** All sixteen, regardless of tier configuration. */
export const PF2E_CATEGORIES: readonly CategoryDescriptor[] = CATEGORY_TABLE.map(toDescriptor);

/**
 * Exported so tests assert against the mapping the client ACTUALLY queries with.
 * A test that re-derives the slug-to-type translation validates its own copy: a
 * typo in the real table would break every search while the test kept passing.
 */
export const AON_TYPE_BY_KEY: ReadonlyMap<string, string> = new Map(
  CATEGORY_TABLE.map((category) => [category.key, category.aonType]),
);

// ---------------------------------------------------------------------------
// Licensing
//
// Both blocks are required and neither substitutes for the other: ORC governs
// the rules text this tool returns, the Community Use Policy governs naming
// Paizo's IP at all. Rendered into the README and the MCP instructions field.
// ---------------------------------------------------------------------------

const ATTRIBUTION: readonly string[] = [
  'Rules text returned by this tool is Licensed Material under the ORC License, held by Paizo Inc. and its licensors. See paizo.com/orclicense. Any redistribution must carry the ORC License and its attribution notices.',
  "This tool uses trademarks and/or copyrights owned by Paizo Inc., used under Paizo's Community Use Policy (paizo.com/licenses/communityuse). We are expressly prohibited from charging you to use or access this content. This tool is not published, endorsed, or specifically approved by Paizo. For more information about Paizo Inc. and Paizo products, visit paizo.com.",
  'Data is retrieved live from Archives of Nethys (2e.aonprd.com), a community project operating under the Community Use Policy and the ORC License since its commercial licensing partnership with Paizo ended on 2026-07-24. Archives of Nethys is not affiliated with this tool.',
];

/**
 * Deliberately terse: the tool description builder appends this to every search
 * tool, so each sentence here is paid for sixteen times over against
 * MAX_TOOLS_LIST_BYTES. It still has to carry all four facts -- Remaster is
 * current, legacy is excluded from search, a legacy id fetched directly comes
 * back labelled, and which key relaxes that.
 */
const CANONICITY_DESCRIPTION =
  'Returns current Pathfinder Remaster rules only; superseded pre-Remaster entries are excluded from search, and one fetched by id is returned marked legacy with the id that replaced it. Set INCLUDE_LEGACY=true to include them in search.';

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface Pf2eProviderOptions {
  env?: Readonly<Record<string, string | undefined>>;
  /** Injectable so tests can drive a fake `fetch` through the real throttle. */
  http?: HttpClient;
  searchCache?: BoundedCache<SearchResult>;
  detailCache?: BoundedCache<ContentEntry>;
  cursors?: SearchCursorStore<string>;
}

export class Pf2eProvider implements SystemProvider {
  readonly key = SYSTEM_KEY;
  readonly displayName = 'Pathfinder Second Edition';

  /**
   * Honest: Elasticsearch does both server-side. `fullText` is the multi_match
   * and phrase-prefix branch; `fuzzy` is that branch's `fuzziness: "auto"`.
   * Nothing here is re-implemented locally over fetched records, and there are
   * no embeddings, so `semantic` is 'none' rather than a hopeful 'local'.
   */
  readonly capabilities = { fullText: 'server', fuzzy: 'server', semantic: 'none' } as const;

  readonly categories: readonly CategoryDescriptor[];

  readonly canonicityPolicy = {
    description: CANONICITY_DESCRIPTION,
    relaxedByConfigKey: INCLUDE_LEGACY_KEY,
  };

  readonly configKeys = PF2E_CONFIG_KEYS;
  readonly attribution = ATTRIBUTION;
  /** Broad enough to answer most things nothing else covers. */
  readonly fallbackCategoryKey = 'rules';

  readonly #client: AonClient;
  readonly #includeLegacy: boolean;
  readonly #searchCache: BoundedCache<SearchResult>;
  readonly #detailCache: BoundedCache<ContentEntry>;
  readonly #cursors: SearchCursorStore<string>;
  readonly #searchVariant: string;

  constructor(options: Pf2eProviderOptions = {}) {
    const env = options.env ?? {};

    // Read once, at construction. A flag re-read per call could change the
    // canonicity behaviour of a running process between two searches.
    this.#includeLegacy = readFlag(env, INCLUDE_LEGACY_KEY, false);

    // All sixteen, always -- every one was verified non-empty under the Remaster
    // filter. `categories` declares what this system HAS; deciding which tiers to
    // expose is the server's call and PF2E_INCLUDE_EXTENDED is applied there,
    // once. The key is declared in configKeys because this provider owns it: that
    // ownership is what lets config validation tell a user their flag is being
    // ignored because it belongs to a different game system.
    this.categories = PF2E_CATEGORIES;

    // Constructing a client and two empty caches is not I/O. Nothing below
    // touches the network until a tool is actually called.
    this.#client = new AonClient(options.http ?? new HttpClient(), {
      includeLegacy: this.#includeLegacy,
    });
    this.#searchCache =
      options.searchCache ??
      new BoundedCache<SearchResult>({
        maxEntries: SEARCH_CACHE_ENTRIES,
        maxBytes: SEARCH_CACHE_BYTES,
      });
    this.#detailCache =
      options.detailCache ??
      new BoundedCache<ContentEntry>({
        maxEntries: DETAIL_CACHE_ENTRIES,
        maxBytes: DETAIL_CACHE_BYTES,
      });
    this.#cursors = options.cursors ?? new SearchCursorStore<string>();
    this.#searchVariant = JSON.stringify([this.#includeLegacy, 'search-after-v1']);
  }

  async search(category: CategoryDescriptor, query: SearchQuery): Promise<SearchResult> {
    const text = query.query?.trim();
    const normalizedQuery = text === undefined || text.length === 0 ? undefined : text;
    const limit = clampLimit(query.limit);
    const identity = {
      ...(normalizedQuery === undefined ? {} : { query: normalizedQuery }),
      filters: query.filters,
      limit,
    };
    const cursorContext = searchCacheKey(this.key, category.key, identity, this.#searchVariant);
    const cursorState =
      query.cursor === undefined ? undefined : this.#cursors.read(query.cursor, cursorContext);
    const cacheKey = searchCacheKey(
      this.key,
      category.key,
      { ...identity, ...(query.cursor === undefined ? {} : { cursor: query.cursor }) },
      this.#searchVariant,
    );
    const cached = this.#searchCache.get(cacheKey);
    if (cached !== undefined) {
      if (cached.nextCursor === undefined) return cached;
      try {
        this.#cursors.read(cached.nextCursor, cursorContext);
        return cached;
      } catch (error) {
        if (!(error instanceof BackendError)) throw error;
      }
    }

    const aonType = this.#aonTypeFor(category);
    // One deadline for the whole call, so a second hop added later inherits what
    // the first one left rather than starting a fresh budget beside it.
    const deadline = new Deadline(TOOL_CALL_BUDGET_MS);
    const page = await this.#client.search({
      aonType,
      ...(normalizedQuery === undefined ? {} : { text: normalizedQuery }),
      filterValues: filterValuesFor(category, query.filters),
      limit,
      ...(cursorState === undefined ? {} : { continuation: cursorState.position }),
      budgetMs: deadline.remainingMs(),
      ...(query.signal === undefined ? {} : { signal: query.signal }),
    });

    const entries: EntrySummary[] = [];
    let dropped = 0;
    for (const doc of page.documents) {
      // The second of the two canonicity mechanisms. In normal operation the
      // server-side must_not already removed these, so this drop never fires and
      // the result is not short of `limit`; when it does fire, a slightly short
      // page is the right price for not showing superseded rules.
      if (!this.#includeLegacy && shouldDropDoc(doc)) {
        dropped += 1;
        continue;
      }

      const id = doc.id;
      // A record with no id cannot round-trip to a details call, so returning it
      // would offer the reader a link that goes nowhere.
      if (id === undefined || id.length === 0) continue;
      entries.push(toSummary(doc, id, category.key));
    }

    // This defence exists for the case where the server-side filter stopped
    // working. If it fires, saying so matters: a silently short page reads as
    // "there is less content than you expected", and an empty one reads as "no
    // such rule exists" -- when the truth is that the backend just regressed.
    if (dropped > 0 && entries.length === 0) {
      throw new BackendError(
        `Every result for this search was superseded content that the server-side ` +
          `canonicity filter should already have excluded (${dropped} dropped). ` +
          `This usually means the upstream filter stopped working.`,
        undefined,
        'canonicity-regression',
      );
    }

    const result: SearchResult = { entries };
    if (page.continuation !== undefined) {
      result.nextCursor = this.#cursors.issue(cursorContext, page.continuation, cursorState?.expiresAt);
    }
    if (dropped > 0) {
      result.degraded = true;
      result.degradedReason = `${dropped} superseded ${
        dropped === 1 ? 'entry' : 'entries'
      } were removed after the backend returned them; this page is short and the server-side canonicity filter may have regressed.`;
    }

    this.#searchCache.set(cacheKey, result);
    return result;
  }

  async getDetails(
    category: CategoryDescriptor,
    id: string,
    signal?: AbortSignal,
  ): Promise<ContentEntry> {
    const cacheKey = detailCacheKey(this.key, category.key, id);
    const cached = this.#detailCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const aonType = this.#aonTypeFor(category);
    const deadline = new Deadline(TOOL_CALL_BUDGET_MS);
    const doc = await this.#client.fetchById(id, deadline.remainingMs(), signal);

    if (doc === undefined) {
      throw new BackendError(`No ${category.displayName} with id "${id}".`, 404);
    }

    // `_mget` will happily return a feat to the spell details tool. Answering a
    // spell lookup with a feat labelled `categoryKey: 'spell'` would be a quiet
    // lie; a missing `type` is not, so it is accepted rather than guessed at.
    if (doc.type !== undefined && doc.type.toLowerCase() !== aonType) {
      throw new BackendError(
        `Id "${id}" is a ${doc.type}, not a ${category.displayName}.`,
        404,
      );
    }

    // No canonicity drop here, whatever INCLUDE_LEGACY says: a document asked
    // for by id is returned, and `toEntry` marks a superseded one `legacy` with
    // the id that replaced it. Silence would be the failure; a label is the fix.
    const entry = toEntry(doc, doc.id ?? id, category.key);
    this.#detailCache.set(cacheKey, entry);
    return entry;
  }

  #aonTypeFor(category: CategoryDescriptor): string {
    const aonType = AON_TYPE_BY_KEY.get(category.key);
    if (aonType === undefined) {
      // Not a backend failure -- the caller handed this provider a category it
      // never published. Failing loudly beats querying AoN for a type nothing
      // in the index has and reporting "no results".
      throw new Error(`Category "${category.key}" is not a Pathfinder 2e category.`);
    }
    return aonType;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collects the filter values the backend will actually be asked for.
 *
 * Iterates the category's DECLARED filters rather than the incoming record, so a
 * key the category never published cannot become a clause against some unrelated
 * AoN field. Schema validation already rejects undeclared keys; this makes the
 * provider safe on its own rather than only in the server that wraps it.
 *
 * Values are trimmed but NOT case-folded. Every filterable AoN field was checked
 * live and all of them are case-insensitive -- `trait`, `rarity` and `type` carry
 * a lowercase normalizer that applies to query terms too ("Fire" and "fire" both
 * return 87 fire spells), and `source` is analyzed text. Lowercasing would be a
 * transform doing nothing, and one that would quietly break the day a field lost
 * its normalizer. Trimming stays: a stray space is a real token on a keyword
 * field.
 */
function filterValuesFor(
  category: CategoryDescriptor,
  filters: Readonly<Record<string, string | number | boolean>>,
): Record<string, string | number | boolean> {
  const values: Record<string, string | number | boolean> = {};
  for (const field of category.filters) {
    const value = filters[field.name];
    if (value === undefined) continue;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      // Dropped rather than sent as an empty term. `{term:{trait:''}}` matches
      // nothing, and those zero results read as a legitimate "no such entry"
      // when the truth is that the filter was blank -- a malformed argument
      // rendered as an answer.
      if (trimmed.length === 0) continue;
      values[field.name] = trimmed;
      continue;
    }
    values[field.name] = value;
  }
  return values;
}

/**
 * A backstop, not the enforcement point: a limit above MAX_LIMIT is rejected by
 * validation before it reaches a provider. This exists so that no code path can
 * put an unbounded `size` in front of unowned community infrastructure.
 */
function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return MAX_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

/**
 * The accepted spellings match the server's own env parsing exactly. They are
 * restated rather than imported because that module reads `node:process`, and a
 * provider that pulls the process environment in through a helper is one edit
 * away from reading env directly instead of being handed it.
 *
 * A value neither list recognizes falls back and says so on stderr rather than
 * throwing: config validation already rejects a malformed INCLUDE_* value before
 * a provider is constructed, and this path exists for direct construction. The
 * fallback is the safe direction -- current rules only.
 */
const TRUE_VALUES: readonly string[] = ['1', 'true', 'yes', 'on'];
const FALSE_VALUES: readonly string[] = ['0', 'false', 'no', 'off'];

function readFlag(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  fallback: boolean,
): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (raw === undefined || raw.length === 0) return fallback;
  if (TRUE_VALUES.includes(raw)) return true;
  if (FALSE_VALUES.includes(raw)) return false;
  console.error(`[pf2e] ${key}="${raw}" is not a boolean; using ${String(fallback)}.`);
  return fallback;
}

/** No I/O: the server must be able to start and list tools with no network at all. */
export const createPf2eProvider: ProviderFactory = (env) => new Pf2eProvider({ env });
