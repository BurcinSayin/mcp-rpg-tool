#!/usr/bin/env node
/**
 * Entry point.
 *
 * The ordering below is load-bearing rather than incidental:
 *
 *   1. Parse and validate every environment variable.
 *   2. Exit non-zero on a bad value, BEFORE any server object exists.
 *   3. Construct the provider (no I/O — the server must start with no network).
 *   4. Construct the server, register tools, then connect the transport.
 *
 * A misconfigured process that never starts is a far better failure than one that
 * completes a handshake and only then reveals it cannot work. And because nothing
 * is registered before step 4, a configuration error cannot leave a client holding
 * a half-usable tool list.
 *
 * stdout belongs to the JSON-RPC transport. Every diagnostic here goes to stderr;
 * one stray stdout write corrupts the protocol stream in a way that is confusing
 * to debug because the symptom appears on the client side.
 */

import process from 'node:process';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { SERVER_NAME, SERVER_VERSION, MAX_TOOLS_LIST_BYTES } from './constants.js';
import { parseConfig, reportAndExitOnFatal } from './config.js';
import { configKeysBySystem, createProvider, knownSystems } from './registry.js';
import { registerProviderTools } from './tools/register.js';

async function main(): Promise<void> {
  const env = process.env as Readonly<Record<string, string | undefined>>;

  // Step 1-2. Nothing has been constructed yet, so exiting here is clean.
  const systems = knownSystems();
  const { config, problems } = parseConfig(env, systems, configKeysBySystem());
  reportAndExitOnFatal(problems);

  if (config === undefined) {
    process.stderr.write('error: configuration could not be resolved.\n');
    process.exit(1);
    return;
  }

  // Step 3. Synchronous and offline by contract.
  const provider = createProvider(config.gameSystem, env);

  // Step 4. The tool list is fixed from here on, which is why listChanged is false
  // below — advertising it would promise notifications that will never be sent and
  // invite clients to hold a re-list subscription for nothing.
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: { listChanged: false } },
      instructions: buildInstructions(provider.displayName, provider.attribution),
    },
  );

  const registered = registerProviderTools(server, provider, {
    includeExtended: config.includeExtended,
  });

  // The SDK does not expose its registered list handler through a public API.
  const protocol = server.server as unknown as {
    _requestHandlers?: ReadonlyMap<
      string,
      (request: { method: string }, extra: { signal: AbortSignal }) => Promise<unknown>
    >;
  };
  const listToolsHandler = protocol._requestHandlers?.get('tools/list');
  if (listToolsHandler) {
    const listResult = await listToolsHandler({ method: 'tools/list' }, { signal: AbortSignal.timeout(1000) });
    const bytes = Buffer.byteLength(JSON.stringify(listResult), 'utf8');
    if (bytes > MAX_TOOLS_LIST_BYTES) {
      process.stderr.write(`fatal: Tool list size (${bytes} bytes) exceeds the maximum budget of ${MAX_TOOLS_LIST_BYTES} bytes.\n`);
      process.exit(1);
    }
  }

  process.stderr.write(
    `${SERVER_NAME} ${SERVER_VERSION} — system "${provider.key}" (${provider.displayName}), ` +
      `${registered.search.length} categories, ${registered.search.length + registered.details.length} tools` +
      `${config.includeExtended ? ', extended enabled' : ''}\n`,
  );

  await server.connect(new StdioServerTransport());
}

function buildInstructions(displayName: string, attribution: readonly string[]): string {
  return [
    `Rules lookup for ${displayName}.`,
    '',
    'Search tools return compact summaries; call the matching details tool with an id for full text.',
    'Every result carries a canonicity marker — "legacy" means the entry has been superseded and',
    'supersededBy names the current version. Prefer current entries unless asked otherwise.',
    '',
    'The active game system is fixed for the lifetime of this process. Changing it requires',
    'restarting the server with a different GAME_SYSTEM value.',
    '',
    'Attribution:',
    ...attribution.map((line) => `  ${line}`),
  ].join('\n');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`fatal: ${message}\n`);
  process.exit(1);
});
