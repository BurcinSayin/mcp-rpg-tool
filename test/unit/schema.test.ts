import { describe, expect, it } from 'vitest';

import {
  buildDetailsInputSchema,
  buildSearchInputSchema,
  normalizeSearchArgs,
  SEARCH_OUTPUT_SCHEMA,
} from '../../src/tools/schema.js';
import {
  DEFAULT_LIMIT,
  MAX_ENUM_VALUES,
  MAX_ID_CHARS,
  MAX_LIMIT,
  MAX_QUERY_CHARS,
} from '../../src/constants.js';
import type { CategoryDescriptor } from '../../src/provider/types.js';

const category = (over: Partial<CategoryDescriptor> = {}): CategoryDescriptor => ({
  key: 'spell',
  displayName: 'Spell',
  description: 'Test category.',
  tier: 'core',
  approximateSize: 100,
  smallClosedSet: false,
  filters: [
    { name: 'level', valueType: 'integer', description: 'Rank.', enforcement: 'server', minimum: 0, maximum: 10 },
    {
      name: 'rarity',
      valueType: 'string',
      description: 'Rarity.',
      enforcement: 'server',
      enumValues: ['common', 'uncommon', 'rare', 'unique'],
    },
  ],
  ...over,
});

describe('input schema generation', () => {
  /**
   * The central honesty rule: a parameter exists only because a provider declared
   * it. A schema that advertises a filter the backend cannot honour is worse than
   * one that omits it — the caller believes it filtered.
   */
  it('emits exactly the declared filters, and nothing else', () => {
    const schema = buildSearchInputSchema(category());
    const props = Object.keys(schema.properties).sort();
    expect(props).toEqual(['cursor', 'level', 'limit', 'query', 'rarity']);
    expect(schema.additionalProperties).toBe(false);
  });

  it('omits a filter the provider did not declare', () => {
    const schema = buildSearchInputSchema(category({ filters: [] }));
    expect(Object.keys(schema.properties).sort()).toEqual(['cursor', 'limit', 'query']);
  });

  it('carries numeric bounds through to the schema', () => {
    const schema = buildSearchInputSchema(category());
    expect(schema.properties['level']).toMatchObject({ type: 'integer', minimum: 0, maximum: 10 });
  });

  /**
   * A short closed vocabulary is an asset: it teaches valid values and prevents
   * malformed input. A long one would bloat the listing clients load into context,
   * so the field degrades to an open string instead of being emitted wholesale.
   */
  it('emits a small vocabulary as an enum', () => {
    const schema = buildSearchInputSchema(category());
    expect(schema.properties['rarity']).toMatchObject({
      enum: ['common', 'uncommon', 'rare', 'unique'],
    });
  });

  it('degrades an oversized vocabulary to an open string', () => {
    const many = Array.from({ length: MAX_ENUM_VALUES + 5 }, (_, i) => `trait-${i}`);
    const schema = buildSearchInputSchema(
      category({
        filters: [
          { name: 'trait', valueType: 'string', description: 'A trait.', enforcement: 'server', enumValues: many },
        ],
      }),
    );
    const trait = schema.properties['trait'] as Record<string, unknown>;
    expect(trait['enum']).toBeUndefined();
    expect(String(trait['description'])).toContain('open vocabulary');
  });

  it('tells the caller a small closed set can be listed wholesale', () => {
    const schema = buildSearchInputSchema(category({ smallClosedSet: true }));
    expect(String((schema.properties['query'] as Record<string, unknown>)['description']))
      .toContain('omit the query');
  });

  it('requires an id on the details schema', () => {
    const schema = buildDetailsInputSchema(category());
    expect(schema.required).toEqual(['id']);
  });
});

describe('argument normalization', () => {
  it('defaults limit when the caller omits it', () => {
    const args = normalizeSearchArgs(category(), { query: 'fire' });
    expect(args.limit).toBe(DEFAULT_LIMIT);
    expect(args.query).toBe('fire');
  });

  it('accepts a limit at the ceiling', () => {
    expect(normalizeSearchArgs(category(), { limit: MAX_LIMIT }).limit).toBe(MAX_LIMIT);
  });

  /**
   * Rejected rather than clamped. Silently returning fewer results than asked for
   * is a surprise that is hard to notice and harder to trace back.
   */
  it('rejects a limit above the ceiling instead of clamping', () => {
    expect(() => normalizeSearchArgs(category(), { limit: MAX_LIMIT + 1 })).toThrow(
      new RegExp(String(MAX_LIMIT)),
    );
  });

  it('rejects a non-integer or non-positive limit', () => {
    expect(() => normalizeSearchArgs(category(), { limit: 0 })).toThrow();
    expect(() => normalizeSearchArgs(category(), { limit: -5 })).toThrow();
    expect(() => normalizeSearchArgs(category(), { limit: 2.5 })).toThrow();
  });

  it('rejects a filter the category never declared', () => {
    expect(() => normalizeSearchArgs(category(), { school: 'evocation' })).toThrow(
      /Unknown filter "school"/,
    );
  });

  it('rejects a value outside a declared vocabulary', () => {
    expect(() => normalizeSearchArgs(category(), { rarity: 'mythic' })).toThrow(/must be one of/);
  });

  it('rejects a value outside declared numeric bounds', () => {
    expect(() => normalizeSearchArgs(category(), { level: 99 })).toThrow(/at most 10/);
    expect(() => normalizeSearchArgs(category(), { level: -1 })).toThrow(/at least 0/);
  });

  it('rejects numeric strings as it strictly expects numbers', () => {
    expect(() => normalizeSearchArgs(category(), { level: '3' })).toThrow(/must be a number/);
  });

  it('treats a blank query as absent so it becomes a list-all', () => {
    expect(normalizeSearchArgs(category(), { query: '   ' }).query).toBeUndefined();
  });
  it('preserves cursor bytes and rejects malformed cursor arguments', () => {
    expect(normalizeSearchArgs(category(), { cursor: ' token ' }).cursor).toBe(' token ');
    for (const cursor of [null, undefined, '', 1, true, 'x'.repeat(37)]) {
      expect(() => normalizeSearchArgs(category(), { cursor })).toThrow(/cursor/);
    }
  });
});

describe('output schema', () => {
  /**
   * `additionalProperties: false` is what makes a shape mismatch between code
   * paths a hard failure instead of something that hides behind an optional field.
   */
  it('closes the summary shape', () => {
    const entries = SEARCH_OUTPUT_SCHEMA.properties['entries'] as Record<string, unknown>;
    const items = entries['items'] as Record<string, unknown>;
    expect(items['additionalProperties']).toBe(false);
    expect(items['required']).toContain('canonicity');
  });

  it('describes degraded so the marker is readable rather than decorative', () => {
    const degraded = SEARCH_OUTPUT_SCHEMA.properties['degraded'] as Record<string, unknown>;
    expect(String(degraded['description']).toLowerCase()).toContain('ranking');
  });
});

describe('input length caps', () => {
  /**
   * These three caps shipped in a security pass with no tests at all. Rejected
   * rather than truncated, matching how `limit` is handled: silently searching
   * for something other than what was asked is worse than refusing.
   */
  it('rejects a query longer than the cap', () => {
    const long = 'x'.repeat(MAX_QUERY_CHARS + 1);
    expect(() => normalizeSearchArgs(category(), { query: long })).toThrow(
      new RegExp(String(MAX_QUERY_CHARS)),
    );
  });

  it('accepts a query exactly at the cap', () => {
    const exact = 'x'.repeat(MAX_QUERY_CHARS);
    expect(normalizeSearchArgs(category(), { query: exact }).query).toHaveLength(MAX_QUERY_CHARS);
  });

  it('advertises the cap in the schema, so the caller learns it before failing', () => {
    const schema = buildSearchInputSchema(category());
    expect(schema.properties['query']).toMatchObject({ maxLength: MAX_QUERY_CHARS });
    expect(buildDetailsInputSchema(category()).properties['id']).toMatchObject({
      maxLength: MAX_ID_CHARS,
    });
  });
});

describe('list-all for a small closed set', () => {
  /**
   * "Omit the query to list every entry" has to actually list every entry. With
   * the ordinary default a set of 11..50 would return a page and claim to be
   * exhaustive — the toy provider's widget category only looked right because it
   * happens to hold exactly ten records.
   */
  it('raises the default limit when a closed set is called with no query', () => {
    expect(normalizeSearchArgs(category({ smallClosedSet: true }), {}).limit).toBe(MAX_LIMIT);
  });

  it('leaves the default alone once a query narrows the set', () => {
    expect(
      normalizeSearchArgs(category({ smallClosedSet: true }), { query: 'grabbed' }).limit,
    ).toBe(DEFAULT_LIMIT);
  });

  it('does not raise it for an ordinary category', () => {
    expect(normalizeSearchArgs(category(), {}).limit).toBe(DEFAULT_LIMIT);
  });

  it('still honours an explicit limit', () => {
    expect(normalizeSearchArgs(category({ smallClosedSet: true }), { limit: 5 }).limit).toBe(5);
  });
});

describe('filter value caps', () => {
  it('rejects an oversized filter value, as it does an oversized query', () => {
    expect(() =>
      normalizeSearchArgs(category(), { rarity: 'x'.repeat(MAX_QUERY_CHARS + 1) }),
    ).toThrow();
  });
});
