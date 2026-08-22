/**
 * Shapes tool results.
 *
 * Every successful result carries both `structuredContent` (validated against the
 * declared output schema) and a text `content` block. The structured form is the
 * one that matters; the text block keeps older clients working, since they render
 * `content` and ignore anything they do not recognise.
 */

/**
 * The index signature is required, not decorative: the SDK types a tool result as
 * a union of several result shapes, and without it TypeScript cannot tell which
 * member this is, so it tries the last one and reports a missing discriminator.
 */
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function successResult(payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

/**
 * An explicit failure.
 *
 * No `structuredContent`: output-schema validation is skipped for error results,
 * so there is no need to invent a placeholder payload that satisfies a schema
 * describing data we do not have.
 *
 * The upstream status is included in the text because it is the difference between
 * "this service is rate limiting us", "this service is down", and "that id does not
 * exist" — three situations the caller should handle differently.
 */
export function errorResult(message: string, upstreamStatus?: number): ToolResult {
  // Only a status the upstream service actually returned is labelled as one.
  // A 404 this server decided for itself -- an id that does not exist, a
  // document of the wrong category -- rendered as "[upstream 404]" destroys the
  // very distinction this function exists to preserve: "the service refused",
  // "the service is down", and "that entry does not exist" are different
  // answers, and only the first two are upstream's.
  const prefix = upstreamStatus === undefined ? '' : `[upstream ${upstreamStatus}] `;
  return {
    content: [{ type: 'text', text: `${prefix}${message}` }],
    isError: true,
  };
}
