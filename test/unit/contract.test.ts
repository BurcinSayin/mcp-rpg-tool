/**
 * Guards on the abstraction itself.
 *
 * With one real backend shipping, these are what keep "the provider interface is
 * backend-neutral" an enforced property rather than a claim in a document.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createToyProvider } from '../../src/provider/toy/index.js';
import { knownSystems, configKeysBySystem, createProvider } from '../../src/registry.js';
import { DEFAULT_LIMIT, MAX_ENUM_VALUES, MAX_LIMIT, MAX_SUMMARY_CHARS, SMALL_CATEGORY_THRESHOLD } from '../../src/constants.js';
import { buildSearchInputSchema } from '../../src/tools/schema.js';
import { searchToolDescription } from '../../src/tools/descriptions.js';
import type { SystemProvider } from '../../src/provider/types.js';

const typesPath = fileURLToPath(new URL('../../src/provider/types.ts', import.meta.url));

describe('the neutral contract', () => {
  /**
   * Structural, not stylistic. A contract that imports nothing cannot pull in a
   * backend client's types, so Elasticsearch shape physically cannot reach what
   * every provider shares. An identifier denylist would only be a spelling check —
   * the real leak would never be spelled `MustNotClause`, it would be a query
   * field shaped like a term clause or a score no other backend can produce.
   */
  it('src/provider/types.ts has zero imports', () => {
    const source = readFileSync(typesPath, 'utf8');
    const withoutComments = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    expect(withoutComments).not.toMatch(/^\s*import\s/m);
    expect(withoutComments).not.toMatch(/\brequire\s*\(/);
    expect(withoutComments).not.toMatch(/\bimport\s*\(/);
  });

  it('names no backend-specific concepts in its declarations', () => {
    // Comments are stripped first: the file legitimately *discusses* Elasticsearch
    // when explaining why none of its declarations may name it. Checking raw text
    // flags that prose, which is a false positive on the very comment that states
    // the rule.
    const source = readFileSync(typesPath, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .toLowerCase();

    // Weak by nature — a spelling check. The toy provider below is the real guard,
    // because the leak that matters would never be spelled "must_not"; it would be
    // a query field shaped like a term clause.
    for (const term of ['elasticsearch', '_source', 'must_not', 'match_phrase', 'aggregation']) {
      expect(source.includes(term), `types.ts declarations should not mention "${term}"`).toBe(
        false,
      );
    }
  });
});

describe('the toy provider', () => {
  /**
   * This is the load-bearing neutrality check. If the contract ever grows a
   * backend-shaped concept, this provider becomes awkward or impossible to write
   * and the build breaks — a semantics check rather than a spelling one.
   */
  it('implements the contract without any backend', async () => {
    const toy = createToyProvider({});
    expect(toy.key).toBe('toy');
    expect(toy.categories.length).toBeGreaterThan(0);

    const widget = toy.categories.find((c) => c.key === 'widget');
    expect(widget).toBeDefined();

    const result = await toy.search(widget!, { query: 'brass', filters: {}, limit: 10 });
    expect(result.entries.length).toBe(1);
    expect(result.entries[0]?.name).toBe('Brass Widget');
  });

  /**
   * The failure this whole design guards against: a query that matches nothing
   * must return nothing. Returning the unfiltered set because the text matched
   * no records is confidently wrong in a way the reader cannot detect.
   */
  it('returns zero results for a query that matches nothing', async () => {
    const toy = createToyProvider({});
    const widget = toy.categories.find((c) => c.key === 'widget')!;

    const result = await toy.search(widget, { query: 'asdfghjkl', filters: {}, limit: 10 });
    expect(result.entries).toHaveLength(0);
  });

  it('applies declared filters', async () => {
    const toy = createToyProvider({});
    const widget = toy.categories.find((c) => c.key === 'widget')!;

    const byLevel = await toy.search(widget, { filters: { level: 1 }, limit: 50 });
    expect(byLevel.entries.length).toBeGreaterThan(0);
    expect(byLevel.entries.every((e) => e.level === 1)).toBe(true);

    const byTrait = await toy.search(widget, { filters: { trait: 'metal' }, limit: 50 });
    expect(byTrait.entries.every((e) => (e.traits ?? []).includes('metal'))).toBe(true);
  });

  it('continues filtered searches in order with normalized text and instance-local handles', async () => {
    const toy = createToyProvider({});
    const widget = toy.categories.find((c) => c.key === 'widget')!;
    const query = { query: ' Widget ', filters: { trait: 'metal' }, limit: 2 };
    const first = await toy.search(widget, query);
    expect(first.entries.map((e) => e.id)).toEqual(['widget-1', 'widget-2']);
    expect(first.nextCursor).toBeDefined();
    const resumed = { ...query, query: 'Widget', cursor: first.nextCursor! };
    const second = await toy.search(widget, resumed);
    expect(second.entries.map((e) => e.id)).toEqual(['widget-5', 'widget-6']);
    expect((await toy.search(widget, resumed)).entries).toEqual(second.entries);
    await expect(createToyProvider({}).search(widget, resumed)).rejects.toThrow(/Invalid or expired/);
    await expect(toy.search(widget, { ...resumed, limit: 3 })).rejects.toThrow(/does not match/);
    expect((await toy.search(widget, resumed)).entries).toEqual(second.entries);
  });

  /**
   * A shipped bug that a fixture concealed: toy's mapper returned `oneLine`
   * uncapped while SEARCH_OUTPUT_SCHEMA declares maxLength and the SDK enforces
   * it, so a long enough record made the tool call fail output validation at
   * runtime. Every fixture body happened to be about forty characters, so it
   * never fired. `note-5` exists to keep it firing.
   */
  it('caps the one-liner so results satisfy the declared output schema', async () => {
    const toy = createToyProvider({});
    const note = toy.categories.find((c) => c.key === 'note')!;
    const result = await toy.search(note, { filters: {}, limit: 50 });

    const longest = Math.max(...result.entries.map((e) => e.oneLine.length));
    expect(longest, 'a fixture long enough to exercise the cap must exist').toBeGreaterThan(100);
    for (const entry of result.entries) {
      expect(entry.oneLine.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
    }
  });

  /**
   * Every toy body used to restate its own name, so `name.includes(t) ||
   * body.includes(t)` could lose either half and every search test still passed.
   * These two search terms appear in exactly one side each.
   */
  it('matches on name and on body independently', async () => {
    const toy = createToyProvider({});
    const widget = toy.categories.find((c) => c.key === 'widget')!;

    const byName = await toy.search(widget, { query: 'Wooden', filters: {}, limit: 10 });
    expect(byName.entries.map((e) => e.id)).toEqual(['widget-3']);

    const byBody = await toy.search(widget, { query: 'buoyant', filters: {}, limit: 10 });
    expect(byBody.entries.map((e) => e.id)).toEqual(['widget-3']);
  });

  /**
   * widget-9 is level 0 deliberately. Nothing filtered by it, so degrading
   * `if (level !== undefined)` to `if (level)` -- which silently drops a zero --
   * went unnoticed.
   */
  it('applies a zero-valued filter rather than treating it as absent', async () => {
    const toy = createToyProvider({});
    const widget = toy.categories.find((c) => c.key === 'widget')!;

    const result = await toy.search(widget, { filters: { level: 0 }, limit: 50 });
    expect(result.entries.map((e) => e.id)).toEqual(['widget-9']);
  });

  /**
   * Nothing asked one category for another's id, so dropping the
   * `categoryKey === category.key` guard survived -- a widget could have been
   * returned from the gizmo details tool, labelled as a gizmo.
   */
  it('refuses an id belonging to a different category', async () => {
    const toy = createToyProvider({});
    const gizmo = toy.categories.find((c) => c.key === 'gizmo')!;
    await expect(toy.getDetails(gizmo, 'widget-1')).rejects.toThrow();
  });

  it('rejects an unknown id rather than returning an empty entry', async () => {
    const toy = createToyProvider({});
    const widget = toy.categories.find((c) => c.key === 'widget')!;
    await expect(toy.getDetails(widget, 'does-not-exist')).rejects.toThrow();
  });
});

describe('registry', () => {
  it('exposes both providers', () => {
    expect(knownSystems()).toContain('toy');
    expect(knownSystems()).toContain('pf2e');
  });

  /**
   * Construction must not touch the network. Asserted because the offline-start
   * guarantee depends on it, and because it forecloses "fixing" a slow first call
   * by warming a cache at startup — which would silently break offline start.
   *
   * The whole suite runs with net connect disabled, so a constructor that issued a
   * request would throw here rather than pass quietly.
   */
  it('constructs every provider without issuing a request', async () => {
    // The previous form was `expect(() => createProvider(...)).not.toThrow()`, which
    // could not fail: a constructor doing `void fetch(...)` returns a rejected
    // promise and throws nothing synchronously. Counting calls is what actually
    // observes the property, and the microtask flush catches an un-awaited fetch.
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = ((...args: unknown[]) => {
      calls += 1;
      return (realFetch as unknown as (...a: unknown[]) => Promise<Response>)(...args);
    }) as unknown as typeof fetch;

    try {
      for (const key of knownSystems()) createProvider(key, {});

      // Microtasks alone are not enough. A constructor doing
      // `setTimeout(() => void fetch(), 0)` -- the "warm the cache at startup"
      // shape this test exists to forbid -- schedules a MACROtask, which no number
      // of `await Promise.resolve()` turns will ever reach. Yielding to the timer
      // queue is what closes that gap.
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setImmediate(resolve));

      expect(calls, 'provider construction must perform no I/O').toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('reports the config keys each provider owns', () => {
    const keys = configKeysBySystem();
    expect(Object.keys(keys).sort()).toEqual(knownSystems());

    // `Array.isArray(owned)` was type-only -- returning [] for every provider
    // passed the unit suite. The keys have to actually match what each provider
    // declares, or config validation silently stops recognising anything.
    for (const [system, owned] of Object.entries(keys)) {
      const provider = createProvider(system, {});
      expect([...owned].sort()).toEqual([...provider.configKeys].sort());
      expect(owned.length, `${system} declares no config keys`).toBeGreaterThan(0);
    }
  });

  it('refuses an unknown system', () => {
    expect(() => createProvider('pathfinder3e', {})).toThrow(/No provider registered/);
  });
});

describe('category declarations', () => {
  const providers = (): SystemProvider[] => knownSystems().map((k) => createProvider(k, {}));

  it('give every category a unique, tool-name-safe key', () => {
    for (const provider of providers()) {
      const keys = provider.categories.map((c) => c.key);
      expect(new Set(keys).size, `${provider.key} has duplicate category keys`).toBe(keys.length);
      for (const key of keys) {
        expect(key, `${provider.key}:${key} is not slug-safe`).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      }
    }
  });

  /**
   * Previously guarded by an `if` whose body never executed -- no declared filter
   * exceeds the cap, so the test was vacuous and would have stayed green whatever
   * the generator did. Now it runs the real generator over every real category and
   * inspects what actually reaches the caller.
   */
  it('emit no oversized enum for any real category', () => {
    let inspected = 0;
    for (const provider of providers()) {
      for (const category of provider.categories) {
        const schema = buildSearchInputSchema(category);
        for (const [name, prop] of Object.entries(schema.properties)) {
          const values = (prop as { enum?: unknown[] }).enum;
          if (values === undefined) continue;
          inspected += 1;
          expect(
            values.length,
            `${provider.key}:${category.key}.${name} emits ${values.length} enum values`,
          ).toBeLessThanOrEqual(MAX_ENUM_VALUES);
        }
      }
    }
    // Guards against this test silently becoming vacuous again if enums disappear.
    expect(
      inspected,
      'no enum was inspected -- this test has stopped checking anything',
    ).toBeGreaterThan(0);
  });

  /**
   * Previously asserted `typeof smallClosedSet === 'boolean'`, which TypeScript
   * already guarantees: every category could have been marked wrongly and this
   * passed. The flag is derived from the declared size, so that is what to check.
   */
  it('mark a category as a small closed set exactly when its size says so', () => {
    for (const provider of providers()) {
      for (const category of provider.categories) {
        expect(
          category.smallClosedSet,
          `${provider.key}:${category.key} declares ${category.approximateSize} entries but smallClosedSet=${category.smallClosedSet}`,
        ).toBe(category.approximateSize <= SMALL_CATEGORY_THRESHOLD);
      }
    }
  });

  /**
   * The check above is a tautology for pf2e: both sides of it derive from the same
   * `count` field, so it compares an expression with itself and would hold however
   * wrong the threshold logic became. These pin literal expectations instead, which
   * is the only way to catch the derivation itself breaking.
   */
  it('agree with known category sizes', () => {
    const pf2e = createProvider('pf2e', {});
    const condition = pf2e.categories.find((c) => c.key === 'condition');
    expect(condition?.approximateSize).toBe(56);
    // 56 is above MAX_LIMIT, so it cannot be listed wholesale however small it feels.
    expect(condition?.smallClosedSet).toBe(false);

    const spell = pf2e.categories.find((c) => c.key === 'spell');
    expect(spell?.approximateSize).toBe(1811);
    expect(spell?.smallClosedSet).toBe(false);

    const toy = createProvider('toy', {});
    const widget = toy.categories.find((c) => c.key === 'widget');
    expect(widget?.approximateSize).toBe(14);
    expect(widget?.smallClosedSet).toBe(true);
  });

  /**
   * Literals pin one instance; this removes the class. The toy provider is the one
   * place the truth is knowable in-process, so its declared size is checked
   * against what it actually returns -- adding a record without updating
   * approximateSize now fails immediately rather than drifting silently.
   */
  it('declare sizes the toy provider can actually produce', async () => {
    const toy = createProvider('toy', {});
    for (const category of toy.categories) {
      const result = await toy.search(category, { filters: {}, limit: MAX_LIMIT });
      expect(
        result.entries.length,
        `toy:${category.key} declares ${category.approximateSize} but returns ${result.entries.length}`,
      ).toBe(category.approximateSize);
    }
  });

  /**
   * Without this the list-all assertions can quietly stop meaning anything. A
   * category at or below DEFAULT_LIMIT returns its full contents whether or not
   * the list-all raise exists, so a suite whose small closed sets are all tiny
   * would pass with the feature deleted. Widget sits at 14 for exactly this
   * reason; this keeps that property from being tuned away by accident.
   */
  it('keep at least one small closed set large enough to detect a list-all regression', () => {
    const discriminating = providers().flatMap((p) =>
      p.categories.filter((c) => c.smallClosedSet && c.approximateSize > DEFAULT_LIMIT),
    );
    expect(
      discriminating.length,
      `no fixture category exceeds DEFAULT_LIMIT (${DEFAULT_LIMIT}), so a list-all regression would be undetectable`,
    ).toBeGreaterThan(0);
  });

  it('declare a plausible size for every category', () => {
    for (const provider of providers()) {
      for (const category of provider.categories) {
        expect(Number.isInteger(category.approximateSize)).toBe(true);
        // Zero would mean shipping a tool over an empty category, which is the
        // defect the size snapshot exists to catch.
        expect(
          category.approximateSize,
          `${provider.key}:${category.key} is empty`,
        ).toBeGreaterThan(0);
      }
    }
  });

  /**
   * The affordance is advertised as "omit the query to list every entry". A
   * category larger than the result ceiling cannot honour that — it returns a
   * capped page while claiming to be exhaustive. Setting the threshold above
   * MAX_LIMIT once made PF2e's 56 conditions "small" and then listed 50 of them.
   */
  it('never promise a list-all a category is too large to deliver', () => {
    expect(SMALL_CATEGORY_THRESHOLD).toBeLessThanOrEqual(MAX_LIMIT);
  });

  /**
   * Renamed. The old name promised "honesty" and the body checked union
   * membership, which TypeScript already guarantees -- it could not fail.
   *
   * Whether a declaration is *true* of the backend cannot be checked from here;
   * the live drift suite is where that belongs. What IS checkable is that the
   * declaration reaches the caller, which is the only reason it is declared at
   * all: a caller told fuzzy matching is unavailable corrects spelling before
   * calling rather than after a failed search.
   */
  it('surface each declared capability in the generated tool description', () => {
    const toy = createProvider('toy', {});
    const pf2e = createProvider('pf2e', {});

    // Discriminating pair: these two declare different fuzzy support, so a
    // description that ignored the declaration would make them read alike.
    expect(toy.capabilities.fuzzy).toBe('none');
    expect(pf2e.capabilities.fuzzy).toBe('server');

    const toyText = searchToolDescription(toy, toy.categories[0]!);
    const pf2eText = searchToolDescription(pf2e, pf2e.categories[0]!);

    expect(toyText).toMatch(/no typo tolerance|exact/i);
    expect(pf2eText).toMatch(/tolerates minor typos/i);
    expect(toyText).not.toBe(pf2eText);
  });

  /**
   * The pair above is not enough on its own. It survives a `capabilitySentence`
   * that ignores the provider entirely and returns one constant satisfying both
   * regexes, and it survives widening the 'local' branch to also take 'server' --
   * which would make pf2e claim its matching is done locally.
   *
   * Driving every value through a synthetic provider and requiring the sentences
   * to be mutually distinct closes both: a constant collapses them, and a widened
   * branch makes two of them collide.
   */
  it('produce a distinct sentence for every capability value', () => {
    const base = createProvider('toy', {});
    const sentenceFor = (fullText: string, fuzzy: string): string => {
      const stub = {
        ...base,
        capabilities: { fullText, fuzzy, semantic: 'none' },
      } as unknown as Parameters<typeof searchToolDescription>[0];
      return searchToolDescription(stub, base.categories[0]!);
    };

    // Every combination a provider can declare, INCLUDING the one toy actually
    // ships. The previous list omitted ['local','none'] -- and omitted it because
    // including it failed: fullText 'local' collapsed into 'server'. A case list
    // drawn to what the implementation can already distinguish is a test shaped
    // around what passes rather than what ships.
    const cases: Array<[string, string]> = [
      ['none', 'none'],
      ['local', 'none'],
      ['local', 'local'],
      ['server', 'none'],
      ['server', 'local'],
      ['server', 'server'],
    ];
    const sentences = cases.map(([ft, fz]) => sentenceFor(ft, fz));

    expect(
      new Set(sentences).size,
      `each capability combination must read differently, got: ${JSON.stringify(sentences)}`,
    ).toBe(cases.length);

    // And each must say the right thing, not merely differ from its neighbours.
    expect(sentences[0]).toMatch(/filtering only|unavailable/i);
    expect(sentences[1]).toMatch(/locally.*exact|exact.*locally/i);
    expect(sentences[2]).toMatch(/locally/i);
    expect(sentences[3]).toMatch(/no typo tolerance|exact/i);
    expect(sentences[4]).toMatch(/locally/i);
    expect(sentences[5]).toMatch(/tolerates minor typos/i);

    // The pair a real provider ships must not read like the server-side one.
    const toyPair = sentenceFor('local', 'none');
    const serverPair = sentenceFor('server', 'none');
    expect(toyPair, 'a locally-matched provider reads as though the backend did it').not.toBe(
      serverPair,
    );
  });

  it('point the canonicity policy at a config key the provider actually owns', () => {
    for (const provider of providers()) {
      expect(provider.configKeys).toContain(provider.canonicityPolicy.relaxedByConfigKey);
    }
  });

  /**
   * A category at tier 'extended' is only reachable if the provider declares the
   * config key that switches the tier on -- config resolves that flag from the
   * active provider's own keys. Toy declared an extended category and no such
   * key, so it was permanently unregistrable: declared, never reachable, and
   * invisible until a test tried to call it.
   */
  it('own a config key for the extended tier whenever they declare one', () => {
    for (const provider of providers()) {
      const hasExtended = provider.categories.some((c) => c.tier === 'extended');
      if (!hasExtended) continue;
      expect(
        provider.configKeys.some((k) => k.endsWith('INCLUDE_EXTENDED')),
        `${provider.key} declares extended categories but no key that can enable them`,
      ).toBe(true);
    }
  });

  /**
   * The existence check on the fallback had nothing able to exercise it: pf2e's
   * fallback is `rules`, which is core and therefore always registered. Toy points
   * its fallback at an extended category, so with the extended tier off the
   * suggestion must disappear rather than name an unregistered tool.
   */
  it('suppress a fallback suggestion when that category is not registered', () => {
    const toy = createProvider('toy', {});
    const core = toy.categories.filter((c) => c.tier === 'core');
    const fallback = toy.categories.find((c) => c.key === toy.fallbackCategoryKey);

    expect(fallback?.tier, 'this test needs an extended-tier fallback to be meaningful').toBe(
      'extended',
    );

    const coreOnly = searchToolDescription(toy, core[0]!, core);
    expect(coreOnly).not.toMatch(/If no category fits/i);

    const withExtended = searchToolDescription(toy, core[0]!, toy.categories);
    expect(withExtended).toMatch(/If no category fits, use toy_search_note/i);
  });

  it('carry attribution', () => {
    for (const provider of providers()) {
      expect(provider.attribution.length).toBeGreaterThan(0);
    }
  });
});
