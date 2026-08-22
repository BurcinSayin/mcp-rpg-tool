/**
 * The backend-neutral provider contract.
 *
 * This file has ZERO imports, enforced by lint (AC-24b). That is structural, not
 * stylistic: a contract that imports nothing cannot pull in a backend client's
 * types, so Elasticsearch shape physically cannot leak into what every provider
 * shares. Nothing here may name a backend concept -- no `term`, no `_source`, no
 * `score`, or backend-specific cursor structures. Opaque cursor strings are neutral.
 * If an edit makes the toy provider awkward to write, that edit is the defect.
 *
 * Deliberately thin during Phase 1. ProviderCapabilities, FilterField and
 * CanonicityPolicy are finalized at contract reconciliation, once both PF2e and
 * the toy provider have actually been built against them -- freezing them before
 * any implementation exists would produce an interface with zero implementations,
 * which is worse than the one-implementation guess the interview warned about.
 */

// ---------------------------------------------------------------------------
// Capability declaration
// ---------------------------------------------------------------------------

/**
 * Where a capability is satisfied. Three states, because a two-state boolean
 * cannot express "the backend does this" versus "we do it ourselves over fetched
 * records" -- and claiming the former while doing neither is exactly the
 * dishonesty the capability system exists to prevent.
 */
export type CapabilitySupport = 'server' | 'local' | 'none';

export interface ProviderCapabilities {
  /** Free-text relevance search. */
  fullText: CapabilitySupport;
  /** Typo tolerance. */
  fuzzy: CapabilitySupport;
  /** Embedding / vector similarity. No provider does this locally. */
  semantic: 'server' | 'none';
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * How a filter is actually applied.
 *
 * There is no third state on purpose. A filter may be declared only if it is
 * server-proven (a value that cannot match returns zero, not the unfiltered set)
 * or client-enforced (applied over an uncapped fetch, before `limit`). Anything
 * else is absent from the schema entirely.
 *
 * This exists because a backend can accept a parameter and silently ignore it,
 * which is worse than never offering the filter: the caller believes it filtered.
 */
export type FilterEnforcement = 'server' | 'client';

export type FilterValueType = 'string' | 'number' | 'integer' | 'boolean';

export interface FilterField {
  name: string;
  valueType: FilterValueType;
  description: string;
  enforcement: FilterEnforcement;
  /**
   * Optional closed vocabulary. Small enums are an asset -- they teach the caller
   * the vocabulary and prevent malformed values. Large ones are not: an enum over
   * a thousand trait names would bloat the tool listing that clients load into
   * model context. Capped by MAX_ENUM_VALUES at schema build time.
   */
  enumValues?: readonly string[];
  minimum?: number;
  maximum?: number;
}

// ---------------------------------------------------------------------------
// Canonicity
// ---------------------------------------------------------------------------

/**
 * Whether an entry is the version currently in force.
 *
 * Silently returning superseded rules is the worst failure this server can have,
 * because the reader cannot detect it -- the text looks perfectly plausible.
 */
export type Canonicity = 'current' | 'legacy' | 'third-party' | 'unknown';

/**
 * Configuration and documentation only -- never a query construct.
 *
 * It deliberately does not carry a function that inspects raw backend payloads:
 * the mapper already converts raw records into entries, so `canonicity` is a
 * required field the mapper sets. Putting a raw-payload function here would be a
 * second place backend shape could live, which is precisely what AC-24b prevents.
 */
export interface CanonicityPolicy {
  /** Surfaced in generated tool descriptions so the caller knows what it is getting. */
  description: string;
  /** Names one entry in SystemProvider.configKeys. Single owner, no duplication. */
  relaxedByConfigKey: string;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export type CategoryTier = 'core' | 'extended';

export interface CategoryDescriptor {
  /** Stable slug used to build tool names. */
  key: string;
  /**
   * Example questions that should route here, and the nearest category they might
   * be confused with. Routing knowledge belongs to the system that has the
   * ontology -- a shared module cannot know that "Demoralize" is an action rather
   * than a feat without encoding one game's rules for every game.
   */
  routing?: {
    examples?: readonly string[];
    /** "for X, use Y instead" -- the disambiguation that matters most. */
    notFor?: string;
  };
  displayName: string;
  /** Base description; routing examples and negative pointers are added at build time. */
  description: string;
  tier: CategoryTier;
  /** Filters belong to the category, not the provider: spells filter by level, creatures by size. */
  filters: readonly FilterField[];
  /**
   * Roughly how many entries this category holds.
   *
   * A snapshot, not a live count -- provider construction performs no I/O, so this
   * is measured once and committed. It will drift as upstream content changes; the
   * live drift suite is what catches that.
   *
   * Declared because `smallClosedSet` is otherwise an unfalsifiable assertion: with
   * nothing to check the flag against, a test can only confirm it is a boolean.
   */
  approximateSize: number;

  /**
   * True for closed sets small enough that searching is pointless and listing is
   * useful. Must equal `approximateSize <= SMALL_CATEGORY_THRESHOLD` -- derived,
   * not independently asserted, so the two cannot drift apart.
   */
  smallClosedSet: boolean;
}

// ---------------------------------------------------------------------------
// Query and results
// ---------------------------------------------------------------------------

export interface SearchQuery {
  /** Free text. Absent for a pure filter or list-all call. */
  query?: string;
  /** Temporary, server-local continuation for the identical search. */
  cursor?: string;
  /**
   * Aborts when the caller's overall deadline expires.
   *
   * The deadline belongs to the whole tool call, not to one hop: without it a
   * provider that makes two sequential requests can spend two full per-request
   * budgets and blow the caller's ceiling, and a call waiting behind a throttle
   * queue can spend the entire budget before its request is even sent.
   */
  signal?: AbortSignal;
  /** Validated against the category's declared filters before it reaches the provider. */
  filters: Readonly<Record<string, string | number | boolean>>;
  limit: number;
}

/** Compact result row. Never carries full rules text -- that is what details are for. */
export interface EntrySummary {
  id: string;
  name: string;
  categoryKey: string;
  level?: number;
  traits?: readonly string[];
  /** One line, capped at MAX_SUMMARY_CHARS. */
  oneLine: string;
  canonicity: Canonicity;
  /** Which book or document this came from, so the reader can see what answered. */
  source?: string;
  url?: string;
}

export interface ContentEntry {
  id: string;
  name: string;
  categoryKey: string;
  level?: number;
  traits?: readonly string[];
  /** Full rules text. */
  body: string;
  canonicity: Canonicity;
  /**
   * For a superseded entry, the id of the version that replaced it. Set whenever
   * canonicity is 'legacy' -- an unlabelled superseded entry is the failure mode.
   */
  supersededBy?: string;
  source?: string;
  url?: string;
  rarity?: string;
}

export interface SearchResult {
  entries: readonly EntrySummary[];
  /** Absent when traversal is complete. */
  nextCursor?: string;
  /**
   * True when a declared capability was unavailable for this result and the
   * provider fell back. Surfaced to the caller and explained in the tool
   * description -- a marker nothing reads is decoration.
   */
  degraded?: boolean;
  degradedReason?: string;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface SystemProvider {
  /** Value of GAME_SYSTEM that selects this provider. */
  key: string;
  displayName: string;
  capabilities: ProviderCapabilities;
  categories: readonly CategoryDescriptor[];
  canonicityPolicy: CanonicityPolicy;
  /** Env vars this provider owns, so a key meant for another provider is rejected loudly. */
  configKeys: readonly string[];
  /** Attribution required by the content licence. Rendered into README and server instructions. */
  attribution: readonly string[];
  /**
   * Category to suggest when nothing else fits. Must name one of this provider's
   * own categories, or be omitted -- pointing at a tool that does not exist is
   * worse than offering no fallback.
   */
  fallbackCategoryKey?: string;

  search(category: CategoryDescriptor, query: SearchQuery): Promise<SearchResult>;
  getDetails(category: CategoryDescriptor, id: string, signal?: AbortSignal): Promise<ContentEntry>;
}

/** Constructed without I/O, so the server can start and list tools with no network. */
export type ProviderFactory = (env: Readonly<Record<string, string | undefined>>) => SystemProvider;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A backend failure that should reach the caller as an explicit error carrying the
 * upstream status -- never as an empty result set, which reads as "nothing exists".
 */
export class BackendError extends Error {
  readonly status: number | undefined;
  readonly detail: string | undefined;
  /**
   * True only when `status` is what the upstream service actually returned.
   *
   * A "no such entry" 404 that this server decided for itself is not an upstream
   * status, and reporting it as one collapses the distinction between "the
   * service refused", "the service is down" and "that entry does not exist" --
   * which is the whole reason the status is surfaced at all.
   */
  readonly fromUpstream: boolean;

  constructor(
    message: string,
    status?: number,
    detail?: string,
    options: { fromUpstream?: boolean } = {},
  ) {
    super(message);
    this.name = 'BackendError';
    this.status = status;
    this.detail = detail;
    this.fromUpstream = options.fromUpstream ?? false;
  }
}
