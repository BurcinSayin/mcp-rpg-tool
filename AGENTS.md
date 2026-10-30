# Repository Guidelines

## Project Overview

`mcp-rpg-tools` is a Node.js MCP stdio server for tabletop-RPG rules lookup. The `pf2e` provider retrieves Pathfinder 2e content from Archives of Nethys (AoN); the synthetic `toy` provider exercises the same contract offline. Preserve the search-then-details workflow: compact search summaries first, full rules text through a separate details tool.

Software is MIT-licensed; retrieved rules have separate attribution and licensing requirements in `docs/providers/pf2e.md`.

## Architecture & Data Flow

1. `src/index.ts` snapshots and validates environment configuration, selects a provider through `src/registry.ts`, registers tools, checks the serialized tool-list budget, then connects `StdioServerTransport`. Provider construction is synchronous and performs no network I/O; discovery must work without AoN. The tool list is fixed for the process lifetime.
2. `src/provider/types.ts` is the import-free, backend-neutral contract. The registry is the concrete-provider import boundary outside providers. Shared code depends on neutral types, never implementations; providers must not import each other. ESLint enforces dependency zones.
3. Providers own categories, filters, capabilities, tiers, and routing metadata. `src/tools/` generates tool names, descriptions, strict schemas, and handlers from those declarations. Success returns structured content plus compatibility text; failures are explicit MCP error results.
4. PF2e requests flow through `src/provider/pf2e/index.ts` (orchestration/cache/cursors), `client.ts` (AoN Elasticsearch queries and response validation), and `map.ts` (neutral entries). Outbound traffic uses `src/http.ts` for identification, throttling, concurrency, deadlines, and response-size limits.
5. Content caches are bounded, process-local LRUs without TTL or disk persistence. `src/pagination.ts` separately stores bounded, expiring opaque cursors bound to the original search context. Restart invalidates both.

PF2e defaults to current content; direct superseded details remain visibly `canonicity: "legacy"` with `supersededBy` when available. Preserve continuation/index-rotation checks. A short or empty page is not terminal while `nextCursor` exists.

## Key Directories

- `src/provider/`: neutral contract and provider-owned implementations/metadata.
- `src/tools/`: shared MCP registration, schemas, descriptions, and result formatting.
- `test/unit/`, `test/integration/`, `test/package/`, `test/live/`: deterministic behavior, built-server protocol, installed artifacts, and opt-in upstream drift checks; `test/setup/` owns unit network isolation.
- `scripts/`: release orchestration and mutation QA.
- `docs/`: provider policies, manual routing acceptance, and release procedures.
- `.github/workflows/`: cross-platform CI and release automation.

Do not hand-edit generated `dist/` or dependency state. Keep artifacts, tarballs, environment secrets, and local IDE/assistant state out of commits.

## Development Commands

```sh
npm ci                      # install from committed lockfile
npm run build               # compile to dist/ and mark entry executable
npm run typecheck           # check source and tests through both tsconfigs
npm run lint                # ESLint, including stdout/dependency restrictions
npm test                    # compile, then run unit + integration projects
npm run test:watch          # unit project only
npm run test:package        # pack, production-install, launch outside checkout
npm run test:live           # deliberate real AoN requests
npm run test:mutation       # Python harness; temporarily rewrites source
npm start                   # run dist/index.js; build first
npm run inspector           # MCP Inspector against built entry
npm run release:check       # dry run; packs, writes artifacts, queries npm
```

Focused example: `npx vitest run --project unit test/unit/cache.test.ts`. Direct integration runs require a current build; `npm test` compiles automatically. `npm pack` removes and rebuilds `dist/` through `prepack`.

## Code Conventions & Common Patterns

- Strict TypeScript ESM: explicit `.js` import suffixes, type-only imports where appropriate, `NodeNext`, and `verbatimModuleSyntax`. Follow surrounding formatting; no formatter is configured. Keep `.mjs` shebang modules LF as required by `.gitattributes`.
- Prefer readonly metadata and ECMAScript `#private` mutable state. Tools follow `<system>_search_<category>` and `<system>_get_<category>_details`.
- Add provider factories and owned environment keys in `src/registry.ts`. Extend provider declarations, not game-specific branches in shared tools. Apply declared local filters before limiting results.
- Put shared budgets/limits in `src/constants.ts`; keep provider-specific query/relevance policy in the adapter.
- Validate boundaries: reject unknown filters, malformed booleans, invalid IDs/cursors, oversized inputs, and malformed upstream responses. Do not silently ignore or clamp invalid arguments.
- Backend/network failures are not empty results. Use `BackendError` and explicit tool errors; preserve upstream status only for genuine upstream errors. Keep legacy, degraded, and truncated results visibly marked.
- Stdout is exclusively JSON-RPC. Diagnostics go to stderr; never use `console.log` or write diagnostics to `process.stdout`.
- Each tool call owns one `Deadline`; propagate its signal and remaining budget through sequential requests and dispose it in `finally`. Preserve the contact-identifying user agent and AoN politeness; do not add automatic retries or extra traffic casually.
- Inject side effects: `HttpClient` accepts fetch/clock/sleep; `Pf2eProvider` accepts HTTP/cache/cursor dependencies; cursor storage accepts a clock. Prefer deterministic injection over global mocks.
- Cache keys must include every result-affecting input using collision-safe encoding. Cursors bind query, filters, limit, and policy context; reject foreign, expired, evicted, or mismatched tokens instead of silently restarting.
- Keep search output compact. Mapping must preserve defensive validation, preferred plain-text fields, safe AoN links, truncation markers, and attribution.

## Important Files

- `src/index.ts`, `src/config.ts`, `src/registry.ts`: entry point, environment validation, provider composition.
- `src/provider/types.ts`: public neutral types and `BackendError`; start here for contract changes.
- `src/tools/{register,schema,descriptions,results}.ts`: generated tool/input/output contracts.
- `src/http.ts`, `src/cache.ts`, `src/pagination.ts`, `src/constants.ts`: runtime policies and bounded state.
- `package.json`, `package-lock.json`: commands, runtime requirements, dependencies, executable, packed-file allowlist.
- `tsconfig.json`, `tsconfig.test.json`: production emit and source/test no-emit checking; preserve the test config's `rootDir` and `exclude` overrides.
- `eslint.config.js`, `vitest.workspace.ts`: enforced boundaries and test-project configuration.
- `README.md`, `docs/providers/pf2e.md`: client setup, configuration, Remaster policy, content notices.
- `docs/acceptance-scenarios.md`, `docs/release-runbook.md`: routing acceptance and release operations.
- `scripts/release.mjs`, `scripts/release.d.mts`: release implementation and declarations used by TypeScript tests.

## Runtime/Tooling Preferences

Use Node **22.19.0+** and npm **11.16.0** (`packageManager` pin), not Bun or another package manager. Supported Node lines are 22 and 24; prefer 24. CI tests the exact minimum 22.19.0 and Node 24 on Ubuntu and Windows. Install with `npm ci`; preserve the lockfile. Node 20 is unsupported.

The ESM entry is `dist/index.js`; MCP clients can launch `node` with its absolute path. README documents the published beta `@orinnadiak/mcp-rpg-tools`, executable `mcp-rpg-tools`, pinned client versions, and Windows launcher handling. Do not assume a stable `latest` release exists.

Configuration is environment-based and fixed at startup: `GAME_SYSTEM=pf2e` (default) or `toy`; PF2e owns `PF2E_INCLUDE_EXTENDED` and `INCLUDE_LEGACY`. Consult toy source/tests for fixture-only flags. System/tool-tier changes require restart. There is no application dev server, disk cache, or offline PF2e mode.

## Testing & QA

Vitest defines four Node projects in `vitest.workspace.ts`:

- **unit**: imports source; use representative inline fixtures and injected fetch/clock/sleep. `test/setup/no-network.ts` blocks unstubbed Undici connections and checks unused interceptors. This guard does not cover spawned children.
- **integration**: launches compiled `dist/index.js` over real JSON-RPC/stdio via `test/integration/stdio-client.ts`. Close every spawned server in `finally`.
- **package**: packs and installs production dependencies in a temporary external consumer, then exercises the installed JS and executable. May need npm/cache/registry access; clean temporary paths in `finally`.
- **live**: deliberate AoN compatibility checks, excluded from default tests and normal CI gates. Keep requests small and courteous.

Run focused checks, then `npm run typecheck`, `npm run lint`, and `npm test`. CI also checks installed packages and a release dry run. No coverage threshold is configured; cover consumer-visible behavior, boundaries, errors, cache/cursor identity, and state transitions rather than implementation trivia. Fixtures should exercise realistic preferred upstream fields, not only fallbacks.

Mutation QA temporarily rewrites source and shares a report file: never run alongside edits or another harness. Missing anchors fail the overall run; do not accept skipped rows as success. Inspect its `shell=True` subprocess invocation before POSIX use. Release dry runs also have side effects and do not replace normal checks; follow `docs/release-runbook.md` for publishing requirements and recovery.

Tool-routing/answer-quality changes require an actual MCP-client session following `docs/acceptance-scenarios.md`. Record invoked tools, returned IDs, transcript evidence, and commit SHA. Data tests and historical acceptance notes do not prove fresh model routing.
