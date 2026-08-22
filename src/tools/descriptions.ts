/**
 * Tool descriptions, treated as a deliverable rather than incidental strings.
 *
 * Naming tools after their system disambiguates between systems; it does nothing
 * for the harder problem, which is choosing correctly *within* one. "How does
 * Demoralize work?" plausibly routes to feats or rules when the answer is an
 * action, and broad catch-alls get over-selected when the caller is unsure.
 * Descriptions are the only real lever on that, and they cost nothing at runtime.
 *
 * The routing knowledge itself lives on the provider, not here. A shared module
 * cannot know that Demoralize is an action rather than a feat without encoding one
 * game's ontology for every game — and an earlier version of this file did exactly
 * that, which produced a toy-system description telling the caller to fall back to
 * a `toy_search_rules` tool that does not exist. The lint rule forbidding an import
 * from a concrete provider did not catch it, because the knowledge had been
 * copy-pasted rather than imported: a spelling check, not a semantics one.
 */

import type { CategoryDescriptor, SystemProvider } from '../provider/types.js';

export function searchToolName(provider: SystemProvider, category: CategoryDescriptor): string {
  return `${provider.key}_search_${toolSlug(category.key)}`;
}

export function detailsToolName(provider: SystemProvider, category: CategoryDescriptor): string {
  return `${provider.key}_get_${toolSlug(category.key)}_details`;
}

function toolSlug(key: string): string {
  return key.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
}

/**
 * Resolves the fallback category, and returns nothing if the provider named one
 * it does not actually have. Suggesting a tool that was never registered is worse
 * than offering no fallback at all.
 */
function fallbackToolName(provider: SystemProvider, active: readonly CategoryDescriptor[]): string | undefined {
  const key = provider.fallbackCategoryKey;
  if (key === undefined) return undefined;
  const target = active.find((c) => c.key === key);
  return target === undefined ? undefined : searchToolName(provider, target);
}

export function searchToolDescription(
  provider: SystemProvider,
  category: CategoryDescriptor,
  /** Categories actually registered, so the fallback cannot name a missing tool. */
  active: readonly CategoryDescriptor[] = provider.categories,
): string {
  const parts: string[] = [
    `Search ${provider.displayName} ${category.displayName} entries. ${category.description}`,
  ];

  const examples = category.routing?.examples ?? [];
  if (examples.length > 0) {
    parts.push(`Use for questions like: ${examples.map((e) => `"${e}"`).join(', ')}.`);
  }
  if (category.routing?.notFor !== undefined) {
    parts.push(category.routing.notFor);
  }

  if (category.smallClosedSet) {
    parts.push('Small closed set — call with no query to list every entry.');
  }

  const fallback = fallbackToolName(provider, active);
  if (fallback !== undefined && fallback !== searchToolName(provider, category)) {
    parts.push(`If no category fits, use ${fallback}.`);
  }

  parts.push(
    'Returns compact summaries only — call the matching details tool with an id for full text.',
    'Pass nextCursor as cursor with identical query, filters and limit; absence means finished. Cursors are temporary and server-local.',
  );
  parts.push(capabilitySentence(provider));
  parts.push(provider.canonicityPolicy.description);

  return parts.join(' ');
}

export function detailsToolDescription(
  provider: SystemProvider,
  category: CategoryDescriptor,
): string {
  return [
    `Retrieve the full ${provider.displayName} ${category.displayName} entry for an id returned by ${searchToolName(provider, category)}.`,
    'Results carry a canonicity marker: "legacy" means the entry has been superseded, and supersededBy names the current version.',
  ].join(' ');
}

/**
 * States what the backend can and cannot do, so the caller can adapt.
 *
 * This is the only consumer of the capability declaration, and the reason it is
 * declared at all: knowing that typo tolerance is unavailable changes behaviour —
 * spelling gets corrected before calling rather than after a failed search.
 */
function capabilitySentence(provider: SystemProvider): string {
  const { fullText, fuzzy } = provider.capabilities;
  if (fullText === 'none') {
    return 'This system supports filtering only; free-text search is unavailable, so use the filters.';
  }
  if (fullText === 'local') {
    // The local/server distinction is the whole reason CapabilitySupport has three
    // states rather than two -- types.ts says so explicitly. Honouring it for
    // `fuzzy` and collapsing it here made a provider's honest "we match locally"
    // reach the caller as though the backend had done it.
    return fuzzy === 'none'
      ? 'Free-text search is matched locally over fetched records and is exact — no typo tolerance, so spell names precisely.'
      : 'Free-text search is matched locally over fetched records, with some tolerance for typos.';
  }
  if (fuzzy === 'none') {
    return 'Free-text search is exact — this system has no typo tolerance, so spell names precisely.';
  }
  if (fuzzy === 'local') {
    return 'Free-text search tolerates minor typos, matched locally over fetched records.';
  }
  return 'Free-text search tolerates minor typos and ranks by relevance.';
}
