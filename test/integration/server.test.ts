/**
 * Exercises the built server the way a client actually sees it: a spawned process
 * speaking JSON-RPC over stdio.
 *
 * These deliberately make no network calls. Listing tools touches no backend, and
 * that is itself the point — the server has to be usable enough to introspect
 * before anyone is online.
 */

import { describe, expect, it } from 'vitest';
import { launchExpectingExit, startServer } from './stdio-client.js';
import { MAX_TOOLS_LIST_BYTES } from '../../src/constants.js';
import type { SearchResult } from '../../src/provider/types.js';

interface ToolsListResult {
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
}

interface InitResult {
  capabilities?: { tools?: { listChanged?: boolean } };
  instructions?: string;
}

describe('startup and tool listing', () => {
  it('starts over stdio and lists tools with no network access', async () => {
    const server = await startServer({ GAME_SYSTEM: 'pf2e' });
    try {
      const result = (await server.request('tools/list')) as ToolsListResult;
      expect(result.tools.length).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  it('registers exactly one search and one details tool per core category', async () => {
    const server = await startServer({ GAME_SYSTEM: 'pf2e' });
    try {
      const { tools } = (await server.request('tools/list')) as ToolsListResult;
      const names = tools.map((t) => t.name);

      const search = names.filter((n) => n.includes('_search_'));
      const details = names.filter((n) => n.includes('_get_'));

      // Eight core categories, verified non-empty under the Remaster filter.
      expect(search).toHaveLength(8);
      expect(details).toHaveLength(8);
      expect(names).toHaveLength(16);

      for (const name of search) {
        const category = name.replace('pf2e_search_', '');
        expect(names).toContain(`pf2e_get_${category}_details`);
      }
    } finally {
      await server.close();
    }
  });

  it('names tools after the system, so two systems can coexist in one client', async () => {
    const server = await startServer({ GAME_SYSTEM: 'pf2e' });
    try {
      const { tools } = (await server.request('tools/list')) as ToolsListResult;
      expect(tools.every((t) => t.name.startsWith('pf2e_'))).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('grows the surface only when the extended tier is enabled', async () => {
    const base = await startServer({ GAME_SYSTEM: 'pf2e' });
    let baseNames: string[];
    try {
      baseNames = ((await base.request('tools/list')) as ToolsListResult).tools.map((t) => t.name);
    } finally {
      await base.close();
    }

    const extended = await startServer({ GAME_SYSTEM: 'pf2e', PF2E_INCLUDE_EXTENDED: 'true' });
    try {
      const names = ((await extended.request('tools/list')) as ToolsListResult).tools.map(
        (t) => t.name,
      );
      // Exact expectation, not merely "more": sixteen categories, two tools each.
      expect(names).toHaveLength(32);
      expect(names).toContain('pf2e_search_deity');
      for (const name of baseNames) expect(names).toContain(name);
    } finally {
      await extended.close();
    }
  });

  /**
   * The list is fixed at startup, so advertising listChanged would promise
   * notifications that never arrive and invite clients to hold a subscription for
   * nothing. Verified against the running server rather than assumed, because the
   * SDK could merge declared capabilities rather than replacing them.
   */
  it('does not advertise a tool list that changes', async () => {
    const server = await startServer({ GAME_SYSTEM: 'pf2e' });
    try {
      const init = server.initialization as InitResult;
      expect(init.capabilities?.tools?.listChanged).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('carries licence attribution in its instructions', async () => {
    const server = await startServer({ GAME_SYSTEM: 'pf2e' });
    try {
      const init = server.initialization as InitResult;

      expect(init.instructions ?? '').toMatch(/ORC/i);
      expect(init.instructions ?? '').toMatch(/Community Use/i);
    } finally {
      await server.close();
    }
  });
});

describe('the tool surface a caller sees', () => {
  it('describes search tools with routing guidance, not just a name', async () => {
    const server = await startServer({ GAME_SYSTEM: 'pf2e' });
    try {
      const { tools } = (await server.request('tools/list')) as ToolsListResult;
      const action = tools.find((t) => t.name === 'pf2e_search_action');

      expect(action?.description ?? '').toContain('Demoralize');
      // The negative pointer is the part that actually moves routing accuracy:
      // "Demoralize" reads like a feat to anyone without the system's ontology.
      expect(action?.description ?? '').toMatch(/not feats|not under feats/i);
    } finally {
      await server.close();
    }
  });

  /**
   * Inverted deliberately. This previously asserted that `condition` advertises a
   * list-all — and kept passing after the affordance was removed, because a stale
   * hardcoded string still made the claim. A test that protects the residue of a
   * promise the system no longer keeps is worse than no test.
   *
   * 56 conditions sit above MAX_LIMIT, so the honest description must NOT offer to
   * enumerate them.
   */
  it('does not offer a list-all for a category too large to enumerate', async () => {
    const server = await startServer({ GAME_SYSTEM: 'pf2e' });
    try {
      const { tools } = (await server.request('tools/list')) as ToolsListResult;
      const condition = tools.find((t) => t.name === 'pf2e_search_condition');
      expect(condition).toBeDefined();
      expect(condition?.description ?? '').not.toMatch(/list every|list all|call with no query/i);
    } finally {
      await server.close();
    }
  });

  it('does offer it where the set genuinely fits in one page', async () => {
    const toy = await startServer({ GAME_SYSTEM: 'toy' });
    try {
      const { tools } = (await toy.request('tools/list')) as ToolsListResult;
      const widget = tools.find((t) => t.name === 'toy_search_widget');
      expect(widget?.description ?? '').toMatch(/list every entry/i);
    } finally {
      await toy.close();
    }
  });

  /**
   * The failure that motivated moving routing onto the provider: a shared module
   * hardcoding one game's ontology emitted "If no category fits, use
   * toy_search_rules" for a system with no such tool. The import-zone lint rule
   * could not catch it, because the knowledge was copy-pasted rather than imported.
   */
  it('never names a fallback tool that was not registered', async () => {
    for (const system of ['pf2e', 'toy']) {
      const server = await startServer({ GAME_SYSTEM: system });
      try {
        const { tools } = (await server.request('tools/list')) as ToolsListResult;
        const names = new Set(tools.map((t) => t.name));
        for (const tool of tools) {
          const referenced = (tool.description ?? '').match(/use ([a-z0-9_]+_search_[a-z0-9_]+)/gi) ?? [];
          for (const phrase of referenced) {
            const named = phrase.replace(/^use /i, '');
            expect(names.has(named), `${tool.name} points at missing tool ${named}`).toBe(true);
          }
        }
      } finally {
        await server.close();
      }
    }
  });

  /**
   * The listing is loaded into a model's context, so its size is a real budget
   * rather than an implementation detail.
   */
  it('keeps the serialized listing within budget', async () => {
    const server = await startServer({ GAME_SYSTEM: 'pf2e', PF2E_INCLUDE_EXTENDED: 'true' });
    try {
      const result = await server.request('tools/list');
      const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
      expect(bytes).toBeLessThan(MAX_TOOLS_LIST_BYTES);
    } finally {
      await server.close();
    }
  });

  it('emits no giant enums in filter schemas', async () => {
    const server = await startServer({ GAME_SYSTEM: 'pf2e' });
    try {
      const { tools } = (await server.request('tools/list')) as ToolsListResult;
      const enums = JSON.stringify(tools).match(/"enum":\[[^\]]*\]/g) ?? [];
      for (const found of enums) {
        expect((found.match(/","/g) ?? []).length + 1).toBeLessThanOrEqual(24);
      }
    } finally {
      await server.close();
    }
  });
});

describe('the toy system', () => {
  it('traverses and replays all pages, rejects changed context, and invalidates handles on restart', async () => {
    const toy = await startServer({ GAME_SYSTEM: 'toy' });
    let savedCursor = '';
    try {
      const search = async (args: Record<string, unknown>, name = 'toy_search_widget') =>
        await toy.request('tools/call', { name, arguments: args }) as {
          isError?: boolean;
          structuredContent?: SearchResult;
        };
      const all = await search({ limit: 50 });
      expect(all.isError).toBeFalsy();
      const ids: string[] = [];
      const counts: number[] = [];
      let cursor: string | undefined;
      let middleIds: string[] = [];
      do {
        const result = await search({ limit: 4, ...(cursor === undefined ? {} : { cursor }) });
        expect(result.isError).toBeFalsy();
        const page = result.structuredContent!;
        const pageIds = page.entries.map((entry) => entry.id);
        ids.push(...pageIds);
        counts.push(pageIds.length);
        if (counts.length === 2) middleIds = pageIds;
        cursor = page.nextCursor;
        if (counts.length === 1) savedCursor = cursor!;
        if (counts.length === 4) expect(page).not.toHaveProperty('nextCursor');
        expect(counts.length).toBeLessThanOrEqual(4);
      } while (cursor !== undefined);
      expect(counts).toEqual([4, 4, 4, 2]);
      expect(ids).toEqual(all.structuredContent!.entries.map((entry) => entry.id));
      expect(new Set(ids).size).toBe(14);
      expect((await search({ limit: 4, cursor: savedCursor })).structuredContent!.entries.map((e) => e.id))
        .toEqual(middleIds);
      for (const changes of [{ query: 'brass' }, { trait: 'metal' }, { limit: 3 }]) {
        const result = await search({ limit: 4, cursor: savedCursor, ...changes });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toBeUndefined();
      }
      expect((await search({ limit: 4, cursor: savedCursor }, 'toy_search_gizmo')).isError).toBe(true);
      expect((await search({ limit: 4, cursor: '00000000-0000-4000-8000-000000000000' })).isError).toBe(true);
      // Failed reads must not consume the valid handle.
      expect((await search({ limit: 4, cursor: savedCursor })).structuredContent!.entries.map((e) => e.id))
        .toEqual(middleIds);
      const detail = await toy.request('tools/call', {
        name: 'toy_get_widget_details', arguments: { id: ids[4] },
      }) as { isError?: boolean; structuredContent?: { id: string; body: string } };
      expect(detail.isError).toBeFalsy();
      expect(detail.structuredContent?.id).toBe(ids[4]);
      expect(detail.structuredContent?.body).toBe('An iron widget. Notably heavy.');
    } finally {
      await toy.close();
    }
    const restarted = await startServer({ GAME_SYSTEM: 'toy' });
    try {
      const result = await restarted.request('tools/call', {
        name: 'toy_search_widget', arguments: { limit: 4, cursor: savedCursor },
      }) as { isError?: boolean; structuredContent?: unknown };
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
    } finally {
      await restarted.close();
    }
  });

  it('produces a different category set from pf2e', async () => {
    const toy = await startServer({ GAME_SYSTEM: 'toy' });
    try {
      const names = ((await toy.request('tools/list')) as ToolsListResult).tools.map((t) => t.name);
      // Asserting the *tool lists* differ would pass trivially, since the system
      // prefix guarantees it. The unprefixed category sets are what must differ.
      const categories = names.filter((n) => n.includes('_search_')).map((n) =>
        n.replace('toy_search_', ''),
      );
      expect(categories).toContain('widget');
      expect(categories).not.toContain('spell');
    } finally {
      await toy.close();
    }
  });

  it('serves a search end to end without any backend', async () => {
    const toy = await startServer({ GAME_SYSTEM: 'toy' });
    try {
      const result = (await toy.request('tools/call', {
        name: 'toy_search_widget',
        arguments: { query: 'brass' },
      })) as { structuredContent?: { entries?: Array<{ id: string }> }; isError?: boolean };

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent?.entries?.[0]?.id).toBe('widget-1');
    } finally {
      await toy.close();
    }
  });

  /**
   * The failure this design exists to prevent: a query matching nothing must
   * return nothing, not the unfiltered category.
   */
  it('returns nothing for a query that matches nothing', async () => {
    const toy = await startServer({ GAME_SYSTEM: 'toy' });
    try {
      const result = (await toy.request('tools/call', {
        name: 'toy_search_widget',
        arguments: { query: 'asdfghjkl' },
      })) as { structuredContent?: { entries?: unknown[] } };

      expect(result.structuredContent?.entries).toHaveLength(0);
    } finally {
      await toy.close();
    }
  });

  it('completes the search-then-details round trip', async () => {
    const toy = await startServer({ GAME_SYSTEM: 'toy' });
    try {
      const search = (await toy.request('tools/call', {
        name: 'toy_search_widget',
        arguments: { query: 'copper' },
      })) as { structuredContent?: { entries?: Array<{ id: string }> } };

      const id = search.structuredContent?.entries?.[0]?.id;
      expect(id).toBeDefined();

      const details = (await toy.request('tools/call', {
        name: 'toy_get_widget_details',
        arguments: { id },
      })) as { structuredContent?: { id?: string; body?: string }; isError?: boolean };

      expect(details.isError).toBeFalsy();
      expect(details.structuredContent?.id).toBe(id);
      expect(details.structuredContent?.body).toBeTruthy();
    } finally {
      await toy.close();
    }
  });

  /**
   * The description promises "call with no query to list every entry". Nothing
   * asserted the server actually delivers it — the promise was tested, the
   * delivery was not, which is the same shape as the tests issue #1 was about.
   *
   * Widget holds fourteen records deliberately: at exactly DEFAULT_LIMIT this
   * assertion could not tell enumeration from a single default page.
   */
  it('lists every entry when a small closed set is called with no query', async () => {
    // Every such category, not only the one that happens to discriminate. Widget
    // (14) is the case that can actually detect a regression, since gizmo (6) and
    // note (4) sit below DEFAULT_LIMIT and would return their full contents even
    // if the list-all raise were removed entirely.
    const expected: Record<string, number> = { widget: 14, gizmo: 6, note: 5 };

    const toy = await startServer({ GAME_SYSTEM: 'toy', TOY_INCLUDE_EXTENDED: 'true' });
    try {
      for (const [category, size] of Object.entries(expected)) {
        const result = (await toy.request('tools/call', {
          name: `toy_search_${category}`,
          arguments: {},
        })) as { structuredContent?: { entries?: unknown[] }; isError?: boolean };

        expect(result.isError, `${category} errored`).toBeFalsy();
        expect(result.structuredContent?.entries, `${category} did not list every entry`).toHaveLength(size);
      }
    } finally {
      await toy.close();
    }
  });

  it('rejects a limit above the ceiling rather than quietly clamping it', async () => {
    const toy = await startServer({ GAME_SYSTEM: 'toy' });
    try {
      const result = (await toy.request('tools/call', {
        name: 'toy_search_widget',
        arguments: { limit: 500 },
      })) as { isError?: boolean; content?: Array<{ text: string }> };

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text ?? '').toContain('50');
    } finally {
      await toy.close();
    }
  });

  it('reports an unknown id as an explicit error, not an empty result', async () => {
    const toy = await startServer({ GAME_SYSTEM: 'toy' });
    try {
      const result = (await toy.request('tools/call', {
        name: 'toy_get_widget_details',
        arguments: { id: 'nope-999' },
      })) as { isError?: boolean; content?: Array<{ text: string }> };

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text ?? '').toMatch(/404|no widget/i);
    } finally {
      await toy.close();
    }
  });

  /**
   * Acceptance scenario X-3 (server half): a parameter exists only if declared.
   * Passing an undeclared filter must fail with an explicit validation error,
   * never silently pass through or be ignored.
   */
  it('rejects an undeclared filter rather than silently ignoring it (scenario X-3)', async () => {
    const toy = await startServer({ GAME_SYSTEM: 'toy' });
    try {
      const result = (await toy.request('tools/call', {
        name: 'toy_search_widget',
        arguments: { undeclared_filter: 'val' },
      })) as { isError?: boolean; content?: Array<{ text: string }> };

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text ?? '').toMatch(/data must NOT have additional properties/i);
    } finally {
      await toy.close();
    }
  });

  it('rejects an undeclared capability on pf2e tools without reaching the network (scenario X-3)', async () => {
    const server = await startServer({ GAME_SYSTEM: 'pf2e' });
    try {
      const result = (await server.request('tools/call', {
        name: 'pf2e_search_spell',
        arguments: { dnd5e_edition: 5 },
      })) as { isError?: boolean; content?: Array<{ text: string }> };

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text ?? '').toMatch(/data must NOT have additional properties/i);
    } finally {
      await server.close();
    }
  });
});

describe('configuration failure', () => {
  /**
   * A misconfigured process that never starts is a far better failure than one
   * that completes a handshake and only then reveals it cannot work.
   */
  it('exits non-zero and names the valid systems, without registering anything', async () => {
    const result = await launchExpectingExit({ GAME_SYSTEM: 'pathfinder3e' });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('pathfinder3e');
    expect(result.stderr).toMatch(/pf2e/);

    // stdout is the protocol channel. A diagnostic written there would corrupt
    // the stream in a way that surfaces as a confusing client-side error.
    expect(result.stdout).toBe('');
  });

  it('rejects a non-boolean flag without logging the invalid value', async () => {
    const result = await launchExpectingExit({
      GAME_SYSTEM: 'pf2e',
      PF2E_INCLUDE_EXTENDED: 'yes-please',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('PF2E_INCLUDE_EXTENDED');
    expect(result.stderr).not.toContain('yes-please');
  });

  it('rejects a generic INCLUDE_ non-boolean flag without logging the invalid value', async () => {
    const result = await launchExpectingExit({
      GAME_SYSTEM: 'pf2e',
      INCLUDE_SECRET: 'my_super_secret_value',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('INCLUDE_SECRET');
    expect(result.stderr).not.toContain('my_super_secret_value');
  });

  /**
   * A flag belonging to another system being silently ignored is the same
   * dishonesty the tool schemas forbid; env vars get the same treatment.
   */
  it('warns when a flag belongs to a different system', async () => {
    const server = await startServer({ GAME_SYSTEM: 'toy', INCLUDE_LEGACY: 'true' });
    try {
      await server.request('tools/list');
      expect(server.stderrText()).toMatch(/INCLUDE_LEGACY/);
    } finally {
      await server.close();
    }
  });

  it('does not instantiate unselected providers (no provider-specific warnings for malformed flags of other systems)', async () => {
    // This will trigger a fatal config error because INCLUDE_LEGACY is not a boolean,
    // which is fine — we want to assert that the pf2e provider itself didn't ALSO
    // print a warning during provider discovery.
    const result = await launchExpectingExit({ GAME_SYSTEM: 'toy', INCLUDE_LEGACY: 'invalid-value' });
    
    expect(result.exitCode).toBe(1);
    // The general config.ts warning is expected:
    expect(result.stderr).toContain('INCLUDE_LEGACY is not a boolean');
    // The provider-specific parse warning from Pf2eProvider constructor should NOT happen:
    expect(result.stderr).not.toContain('[pf2e] INCLUDE_LEGACY');
  });

  it('exits non-zero at startup if the tool listing exceeds MAX_TOOLS_LIST_BYTES', async () => {
    // The toy system is instrumented to bloat its categories when this flag is set,
    // pushing the serialized tools list well past the 64KB budget.
    const result = await launchExpectingExit({
      GAME_SYSTEM: 'toy',
      TOY_BLOAT_TOOLS: 'true',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/fatal: Tool list size .* exceeds the maximum budget/);
    expect(result.stdout).toBe('');
  });
});
