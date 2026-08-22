/**
 * Builds tool input schemas from provider-declared filter fields.
 *
 * Schemas are constructed as plain JSON Schema data and handed to the SDK's
 * `fromJsonSchema`, rather than reflecting into a schema library's chainable
 * builder. The filter set is only known at runtime, so data construction is the
 * natural fit -- and it keeps the generated schema trivially inspectable, which
 * matters because the schema is the contract the caller sees.
 *
 * The governing rule: a parameter appears here only if the provider declared it.
 * Absence is the honest signal that a backend cannot honour something. Nothing is
 * accepted-and-ignored.
 */

import { fromJsonSchema } from '@modelcontextprotocol/server';
import type { CategoryDescriptor, FilterField } from '../provider/types.js';
import {
  DEFAULT_LIMIT,
  MAX_ENUM_VALUES,
  MAX_LIMIT,
  MAX_ID_CHARS,
  MAX_QUERY_CHARS,
  MAX_SUMMARY_CHARS,
  MAX_BODY_CHARS,
  MAX_CURSOR_CHARS,
} from '../constants.js';
import { parseBoolean } from '../config.js';

export interface JsonSchemaObject {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
}

/**
 * A filter's schema fragment.
 *
 * Enums are capped rather than banned. A short closed vocabulary (rarity, size) is
 * an asset: it teaches the caller the valid values and prevents malformed input.
 * A long one -- every trait name in the corpus -- would bloat the tool listing that
 * clients load into context, so above the cap the field degrades to a plain string
 * whose description carries the guidance instead.
 */
function filterSchema(field: FilterField): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type: field.valueType,
    description: field.description,
    ...(field.valueType === 'string' ? { maxLength: MAX_QUERY_CHARS } : {}),
  };

  if (field.enumValues !== undefined && field.enumValues.length > 0) {
    if (field.enumValues.length <= MAX_ENUM_VALUES) {
      base['enum'] = [...field.enumValues];
    } else {
      base['description'] =
        `${field.description} (open vocabulary; ${field.enumValues.length} known values)`;
    }
  }
  if (field.minimum !== undefined) base['minimum'] = field.minimum;
  if (field.maximum !== undefined) base['maximum'] = field.maximum;

  return base;
}

export function buildSearchInputSchema(category: CategoryDescriptor): JsonSchemaObject {
  const properties: Record<string, unknown> = {};

  properties['query'] = {
    type: 'string',
    maxLength: MAX_QUERY_CHARS,
    description: category.smallClosedSet
      ? `Text to search for. This is a small closed set (${category.displayName}) — omit the query to list every entry.`
      : `Text to search for. Matches names first, then body text, with typo tolerance.`,
  };

  for (const field of category.filters) {
    properties[field.name] = filterSchema(field);
  }

  properties['limit'] = {
    type: 'integer',
    description: `Maximum results to return (default ${DEFAULT_LIMIT}).`,
    minimum: 1,
    maximum: MAX_LIMIT,
    default: DEFAULT_LIMIT,
  };
  properties['cursor'] = { type: 'string', minLength: 1, maxLength: MAX_CURSOR_CHARS };

  return { type: 'object', properties, additionalProperties: false };
}

export function buildDetailsInputSchema(category: CategoryDescriptor): JsonSchemaObject {
  return {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        maxLength: MAX_ID_CHARS,
        description: `The id of a ${category.displayName} entry, taken from a prior search result.`,
      },
    },
    required: ['id'],
    additionalProperties: false,
  };
}

/**
 * Output schemas.
 *
 * `additionalProperties: false` on the summary is load-bearing: it is what makes a
 * shape mismatch between code paths a hard failure rather than something that
 * silently hides behind an optional field.
 */
export const SEARCH_OUTPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    entries: {
      type: 'array',
      description: 'Compact result rows. Call the matching details tool for full text.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          categoryKey: { type: 'string' },
          level: { type: 'number' },
          traits: { type: 'array', items: { type: 'string' } },
          oneLine: { type: 'string', maxLength: MAX_SUMMARY_CHARS },
          canonicity: { type: 'string', enum: ['current', 'legacy', 'third-party', 'unknown'] },
          source: { type: 'string' },
          url: { type: 'string' },
        },
        required: ['id', 'name', 'categoryKey', 'oneLine', 'canonicity'],
        additionalProperties: false,
      },
    },
    degraded: {
      type: 'boolean',
      description:
        'True when a declared capability was unavailable for this result and the provider fell back. Ordering may be poor; treat ranking as unreliable.',
    },
    degradedReason: { type: 'string' },
    nextCursor: { type: 'string', minLength: 1, maxLength: MAX_CURSOR_CHARS },
  },
  required: ['entries'],
  additionalProperties: false,
};

export const DETAILS_OUTPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    categoryKey: { type: 'string' },
    level: { type: 'number' },
    traits: { type: 'array', items: { type: 'string' } },
    body: { type: 'string', maxLength: MAX_BODY_CHARS },
    canonicity: {
      type: 'string',
      enum: ['current', 'legacy', 'third-party', 'unknown'],
      description:
        '"legacy" means this entry has been superseded by a newer version; see supersededBy.',
    },
    supersededBy: {
      type: 'string',
      description: 'Id of the entry that replaced this one, when canonicity is "legacy".',
    },
    source: { type: 'string' },
    url: { type: 'string' },
    rarity: { type: 'string' },
  },
  required: ['id', 'name', 'categoryKey', 'body', 'canonicity'],
  additionalProperties: false,
};

/** Wraps a JSON Schema for the SDK. The result is accepted directly as an input or output schema. */
export function toStandardSchema(schema: JsonSchemaObject): ReturnType<typeof fromJsonSchema> {
  return fromJsonSchema(schema as unknown as Parameters<typeof fromJsonSchema>[0]);
}

/**
 * Validates and normalizes caller arguments against what the category actually
 * declared. Anything undeclared is rejected rather than passed through -- the
 * provider should never receive a filter the schema did not advertise.
 */
export function normalizeSearchArgs(
  category: CategoryDescriptor,
  args: Readonly<Record<string, unknown>>,
): { query?: string; cursor?: string; filters: Record<string, string | number | boolean>; limit: number } {
  const declared = new Map(category.filters.map((f) => [f.name, f]));
  const filters: Record<string, string | number | boolean> = {};

  for (const [name, value] of Object.entries(args)) {
    if (name === 'query' || name === 'limit' || name === 'cursor') continue;
    const field = declared.get(name);
    if (field === undefined) {
      throw new Error(
        `Unknown filter "${name}" for ${category.displayName}. Declared filters: ${
          category.filters.map((f) => f.name).join(', ') || '(none)'
        }`,
      );
    }
    if (value === undefined || value === null) continue;
    filters[name] = coerce(field, value);
  }

  const rawLimit = args['limit'];
  // A small closed set called with no query is a list-all, so the default rises
  // to the ceiling rather than the usual page. Otherwise "omit the query to list
  // every entry" is untrue for any such category above DEFAULT_LIMIT -- and the
  // toy provider's widget category only read as correct because it happens to
  // hold exactly ten records.
  const listAll =
    category.smallClosedSet &&
    (typeof args['query'] !== 'string' || args['query'].trim() === '');
  let limit = listAll ? MAX_LIMIT : DEFAULT_LIMIT;
  if (rawLimit !== undefined && rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`limit must be a positive integer, received ${String(rawLimit)}.`);
    }
    // Rejected, not silently clamped: quietly returning fewer results than asked
    // for is the kind of surprise that is hard to notice and harder to debug.
    if (parsed > MAX_LIMIT) {
      throw new Error(`limit must not exceed ${MAX_LIMIT}, received ${parsed}.`);
    }
    limit = parsed;
  }

  const rawQuery = args['query'];
  const query = typeof rawQuery === 'string' && rawQuery.trim() !== '' ? rawQuery.trim() : undefined;

  // Rejected rather than truncated, matching how `limit` is handled: silently
  // searching for something other than what was asked is worse than refusing.
  // The text is repeated across several clauses in the outbound query, so an
  // unbounded value is also amplified against infrastructure we do not own.
  if (query !== undefined && query.length > MAX_QUERY_CHARS) {
    throw new Error(`query must not exceed ${MAX_QUERY_CHARS} characters.`);
  }

  const cursor = args['cursor'];
  if ('cursor' in args && (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > MAX_CURSOR_CHARS)) {
    throw new Error(`cursor must be a nonempty string of at most ${MAX_CURSOR_CHARS} characters.`);
  }
  return { ...(query === undefined ? {} : { query }), ...(typeof cursor === 'string' ? { cursor } : {}), filters, limit };
}

function coerce(field: FilterField, value: unknown): string | number | boolean {
  switch (field.valueType) {
    case 'integer':
    case 'number': {
      if (typeof value !== 'number') {
        throw new Error(`Filter "${field.name}" must be a number, received ${Array.isArray(value) ? 'array' : typeof value}.`);
      }
      if (!Number.isFinite(value)) {
        throw new Error(`Filter "${field.name}" must be a finite number, received ${String(value)}.`);
      }
      if (field.valueType === 'integer' && !Number.isInteger(value)) {
        throw new Error(`Filter "${field.name}" must be an integer, received ${String(value)}.`);
      }
      if (field.minimum !== undefined && value < field.minimum) {
        throw new Error(`Filter "${field.name}" must be at least ${field.minimum}.`);
      }
      if (field.maximum !== undefined && value > field.maximum) {
        throw new Error(`Filter "${field.name}" must be at most ${field.maximum}.`);
      }
      return value;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        const parsed = parseBoolean(value);
        if (parsed !== undefined) return parsed;
      }
      throw new Error(`Filter "${field.name}" must be a boolean, received ${Array.isArray(value) ? 'array' : typeof value}.`);
    }
    case 'string':
    default: {
      if (typeof value !== 'string') {
        throw new Error(`Filter "${field.name}" must be a string, received ${Array.isArray(value) ? 'array' : typeof value}.`);
      }
      const text = value;
      // Same reasoning as the query cap: a filter value is equally
      // caller-supplied and lands in the same outbound body, so leaving it
      // unbounded while capping `query` guards one door and not the other.
      if (text.length > MAX_QUERY_CHARS) {
        throw new Error(
          `Filter "${field.name}" must not exceed ${MAX_QUERY_CHARS} characters.`,
        );
      }
      if (
        field.enumValues !== undefined &&
        field.enumValues.length > 0 &&
        field.enumValues.length <= MAX_ENUM_VALUES &&
        !field.enumValues.includes(text)
      ) {
        throw new Error(
          `Filter "${field.name}" must be one of: ${field.enumValues.join(', ')}.`,
        );
      }
      return text;
    }
  }
}
