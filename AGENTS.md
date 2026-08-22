# Repository Guidelines

## Project Overview

`mcp-rpg-tools` is a private Node.js MCP server that gives AI assistants tabletop-RPG rules lookup. The production provider serves Pathfinder 2e content from Archives of Nethys (AoN); the in-memory `toy` provider proves the provider contract remains backend-neutral.

Each active category exposes two system-prefixed tools: a compact search tool and a details tool for the selected ID. Preserve this search-then-details flow: returning full rules text from search wastes context and changes the public MCP contract.

## Architecture & Data Flow

1. `src/index.ts` snapshots environment variables, validates them through `src/config.ts`, creates the selected provider through `src/registry.ts`, generates the fixed MCP tool list, checks its serialized size, then connects `StdioServerTransport`.
2. `src/tools/register.ts` creates search/details handlers from provider category metadata. `schema.ts` generates strict runtime schemas; `descriptions.ts` builds model-facing routing text; `results.ts` emits structured content plus compatibility text.
3. Providers implement the zero-import contract in `src/provider/types.ts`. Only `src/registry.ts` may import concrete providers. Shared code must not reach into `provider/pf2e/` or `provider/toy/`, and providers must not depend on one another; ESLint enforces these zones.
4. PF2e requests flow through `provider/pf2e/index.ts` to `client.ts` (AoN Elasticsearch query/response handling), then `map.ts` converts backend documents to neutral entries. All outbound traffic uses `src/http.ts` for identity, throttling, concurrency, deadlines, aborts, response limits, and explicit upstream errors.
5. `src/cache.ts` provides bounded in-memory LRU caches. State lasts only for the process: there is no disk cache, TTL, or offline mode.

The tool list and configuration are fixed at startup. Provider construction must remain no-I/O so tool discovery works without contacting AoN. Default PF2e search excludes superseded content; directly fetched legacy entries must remain labeled `canonicity: "legacy"` with `supersededBy` when available.

## Key Directories

- `src/provider/`: backend-neutral contract plus PF2e and toy implementations.
- `src/tools/`: generated MCP schemas, names/descriptions, registration, and result formatting.
- `test/unit/`: deterministic tests for pure helpers, HTTP behavior, caches, schemas, mappings, and provider contracts.
- `test/integration/`: spawned `dist/index.js` JSON-RPC/stdio tests using `stdio-client.ts`.
- `test/live/`: opt-in AoN compatibility/drift checks; never part of the default offline suite.
- `test/setup/`: unit-test network isolation.
- `docs/acceptance-scenarios.md`: manual model/tool-routing acceptance checks.
- `scripts/mutation-matrix.py`: invariant-focused mutation QA.

Do not edit generated `dist/`, dependency state, `.omc/`, `.idea/`, or `.codegraph/` content.

## Development Commands

```powershell
npm install                 # install from the committed npm lockfile
npm run build               # compile src/ to dist/
npm run typecheck           # type-check src/ and test/ via both tsconfig files
npm run lint                # ESLint, including architecture and stdout rules
npm test                    # build, then unit + integration projects
npm run test:watch          # unit project in watch mode
npm run test:live           # real AoN calls; opt in deliberately
npm run test:mutation       # mutation matrix; requires Python
npm start                   # run node dist/index.js
npm run inspector           # inspect the built MCP server
```

There is no application dev server, source watcher, formatter script, coverage command, or checked-in CI workflow. `scripts/mutation-matrix.py` currently contains a workstation-specific absolute `chdir`; fix that before relying on the command from another clone.

## Code Conventions & Common Patterns

- Use strict TypeScript ESM and explicit `.js` suffixes in source imports (`NodeNext` resolution). Prefer `readonly` metadata and ECMAScript `#private` fields for mutable implementation state.
- Keep backend-neutral types in `src/provider/types.ts`; it intentionally has zero imports. Add provider-specific concepts only inside that provider.
- Register providers and their owned configuration keys in `src/registry.ts`. Categories, filters, capabilities, and routing examples are provider metadata; tool schemas and names are generated from them.
- Centralize tunable limits and budgets in `src/constants.ts`. Do not duplicate numeric policy literals across modules.
- Validate at boundaries. Reject unknown filters, malformed booleans, oversized inputs, invalid IDs, and malformed upstream responses rather than clamping or silently ignoring them.
- Fail explicitly. A backend/network failure must never become an empty result set. Preserve upstream status only for true upstream errors; mark degraded, legacy, and truncated results visibly.
- Stdout is the JSON-RPC transport. Never use `console.log` or write diagnostics to stdout; use stderr. A stray line corrupts the MCP protocol.
- Async tool handlers create one whole-call `Deadline`, pass its `AbortSignal` through providers and HTTP, and dispose it in `finally`. Keep one shared budget across sequential network hops.
- Inject side-effectful dependencies for deterministic behavior: `HttpClient` accepts fetch/clock/sleep functions, and `Pf2eProvider` accepts client/cache options. Do not add global mocks when injection fits.
- Preserve AoN politeness controls and the contact-identifying user agent. Do not add automatic retries or extra traffic without an explicit design change.
- Naming is domain-oriented (`Provider`, `Client`, `Descriptor`, `Entry`, `Result`). Tool names follow `<system>_search_<category>` and `<system>_get_<category>_details`.

## Important Files

- `src/index.ts`: process entry, MCP server setup, fixed tool-list size guard.
- `src/config.ts`: environment parsing and fatal/warning diagnostics.
- `src/registry.ts`: provider composition root and sole concrete-provider import exception.
- `src/provider/types.ts`: backend-neutral public contract and `BackendError`.
- `src/provider/pf2e/{index,client,map}.ts`: PF2e orchestration, AoN adapter, and pure mapping.
- `src/http.ts`: sole outbound HTTP path and deadline implementation.
- `src/cache.ts`: bounded LRU and collision-safe cache keys.
- `src/constants.ts`: authoritative runtime limits.
- `package.json`: executable scripts, dependencies, Node engine, and built entry point.
- `tsconfig.json` / `tsconfig.test.json`: production emit and source-plus-test type checks. The test config must override inherited `rootDir` and `exclude`.
- `eslint.config.js`: protocol-safety and provider import-boundary rules.
- `vitest.workspace.ts`: unit, integration, and live project boundaries.
- `README.md`: user-facing behavior, configuration, Remaster policy, and attribution.

## Runtime/Tooling Preferences

Use Node.js 20 or newer and npm; `package-lock.json` is authoritative. The project is ESM (`"type": "module"`) and builds to `dist/index.js`. It is not published to npm, so MCP clients point at the locally built entry point.

Runtime configuration is environment-based. `GAME_SYSTEM` defaults to `pf2e`; valid values are `pf2e` and `toy`. PF2e flags include `PF2E_INCLUDE_EXTENDED` and `INCLUDE_LEGACY`. Changing the system requires a restart. Consult provider source/tests for toy-only flags because the README table is not exhaustive.

AoN is live, unowned infrastructure with no stable published API contract. Preserve defensive response validation, licensing/attribution text, same-origin URL handling, and the rotating-safe `aon` index alias.

## Testing & QA

Vitest uses three named projects in `vitest.workspace.ts`:

- `unit`: `test/unit/**/*.test.ts`; network connections are disabled by Undici setup. Prefer inline representative data and injected `fetchImpl`, clocks, and sleeps.
- `integration`: `test/integration/**/*.test.ts`; exercises the built server over real stdio JSON-RPC. Always close spawned servers in `finally`.
- `live`: `test/live/**/*.test.ts`; intentionally reaches AoN to detect schema/index drift and is not a normal gating suite.

Name tests `*.test.ts` and place them by behavioral boundary, not by implementation convenience. Test observable contracts, edge conditions, errors, cache invariants, and protocol output. There are no coverage thresholds; quality is enforced through contract tests, network isolation, integration scenarios, and the mutation matrix.

For a focused change, run the narrowest relevant Vitest project/file first, then `npm run typecheck`, `npm run lint`, and `npm test`. Use `npm run test:live` only for upstream compatibility work. For changes to load-bearing invariants, run the mutation matrix after correcting its path portability issue. For tool routing or answer quality, also exercise the relevant checklist in `docs/acceptance-scenarios.md`; automated data tests cannot prove that an assistant selects the right tool.
