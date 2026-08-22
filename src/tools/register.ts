/**
 * Generates the tool surface from whatever the loaded provider declares.
 *
 * The category list belongs to the game system, not to this server, so tools are
 * built in a loop over provider-declared categories rather than written out by
 * hand. Two systems legitimately expose different tools, and that is the design
 * working rather than an inconsistency to paper over.
 *
 * The list is fixed once at startup and never mutates, which is why the server
 * advertises listChanged: false. Switching systems means restarting the process.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import type {
  CategoryDescriptor,
  ContentEntry,
  SearchResult,
  SystemProvider,
} from '../provider/types.js';
import { BackendError } from '../provider/types.js';
import { MAX_ID_CHARS, TOOL_CALL_BUDGET_MS } from '../constants.js';
import { Deadline } from '../http.js';
import {
  DETAILS_OUTPUT_SCHEMA,
  SEARCH_OUTPUT_SCHEMA,
  buildDetailsInputSchema,
  buildSearchInputSchema,
  normalizeSearchArgs,
  toStandardSchema,
} from './schema.js';
import {
  detailsToolDescription,
  detailsToolName,
  searchToolDescription,
  searchToolName,
} from './descriptions.js';
import { errorResult, successResult } from './results.js';

export interface RegisterOptions {
  includeExtended: boolean;
}

export interface RegisteredToolNames {
  search: string[];
  details: string[];
}

export function registerProviderTools(
  server: McpServer,
  provider: SystemProvider,
  options: RegisterOptions,
): RegisteredToolNames {
  const active = provider.categories.filter(
    (category) => category.tier === 'core' || options.includeExtended,
  );

  const names: RegisteredToolNames = { search: [], details: [] };

  for (const category of active) {
    names.search.push(registerSearch(server, provider, category, options, active));
    names.details.push(registerDetails(server, provider, category));
  }

  return names;
}

function registerSearch(
  server: McpServer,
  provider: SystemProvider,
  category: CategoryDescriptor,
  options: RegisterOptions,
  active: readonly CategoryDescriptor[],
): string {
  const name = searchToolName(provider, category);

  server.registerTool(
    name,
    {
      // `active`, not all categories: with the extended tier off, a fallback
      // pointing at an unregistered tool would be worse than none.
      description: searchToolDescription(provider, category, active),
      inputSchema: toStandardSchema(buildSearchInputSchema(category)),
      outputSchema: toStandardSchema(SEARCH_OUTPUT_SCHEMA),
    },
    async (args: unknown) => {
      const deadline = new Deadline(TOOL_CALL_BUDGET_MS);
      // A real abort, not a note in the error text. Without this the deadline was
      // computed, formatted into a message and otherwise ignored, so the effective
      // ceiling was one request's budget rather than the tool call's.
      const expiry = deadline.abortSignal();
      try {
        const normalized = normalizeSearchArgs(
          category,
          (args ?? {}) as Record<string, unknown>,
        );
        const result: SearchResult = await provider.search(category, {
          ...normalized,
          signal: expiry.signal,
        });
        return successResult({
          entries: result.entries,
          ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
          ...(result.degraded === undefined ? {} : { degraded: result.degraded }),
          ...(result.degradedReason === undefined
            ? {}
            : { degradedReason: result.degradedReason }),
        });
      } catch (error) {
        return toolError(error, deadline.remainingMs());
      } finally {
        expiry.dispose();
      }
    },
  );

  return name;
}

function registerDetails(
  server: McpServer,
  provider: SystemProvider,
  category: CategoryDescriptor,
): string {
  const name = detailsToolName(provider, category);

  server.registerTool(
    name,
    {
      description: detailsToolDescription(provider, category),
      inputSchema: toStandardSchema(buildDetailsInputSchema(category)),
      outputSchema: toStandardSchema(DETAILS_OUTPUT_SCHEMA),
    },
    async (args: unknown) => {
      const deadline = new Deadline(TOOL_CALL_BUDGET_MS);
      const expiry = deadline.abortSignal();
      try {
        const id = (args as { id?: unknown } | undefined)?.id;
        if (typeof id !== 'string' || id.trim() === '') {
          throw new Error('id is required and must be a non-empty string.');
        }
        if (id.length > MAX_ID_CHARS) {
          throw new Error(`id must not exceed ${MAX_ID_CHARS} characters.`);
        }
        const entry: ContentEntry = await provider.getDetails(category, id.trim(), expiry.signal);
        return successResult(entry as unknown as Record<string, unknown>);
      } catch (error) {
        return toolError(error, deadline.remainingMs());
      } finally {
        expiry.dispose();
      }
    },
  );

  return name;
}

/**
 * Turns a failure into an explicit error result carrying the upstream status.
 *
 * Never an empty result set: "the backend refused" and "no such rule exists" are
 * different answers, and collapsing them into an empty list tells the caller the
 * second when the truth is the first.
 */
function toolError(error: unknown, remainingMs: number): ReturnType<typeof errorResult> {
  if (error instanceof BackendError) {
    // The status is rendered once, by errorResult, and only when upstream
    // actually produced it. Appending it here as well produced text like
    // `[upstream 404] No Spell with id "x". (HTTP 404)` -- doubled, and wrong
    // twice over, since that 404 was this server's own judgement.
    const detail = error.detail === undefined ? '' : ` [${error.detail}]`;
    return errorResult(
      `${error.message}${detail}`,
      error.fromUpstream ? error.status : undefined,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  const budgetNote = remainingMs <= 0 ? ' The tool-call budget was exhausted.' : '';
  return errorResult(`${message}${budgetNote}`);
}
