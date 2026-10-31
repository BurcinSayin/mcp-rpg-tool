# Repository Guidelines

## Project Overview

`mcp-rpg-tools` is a Node.js MCP server for tabletop-RPG rules lookup. The production `pf2e` provider retrieves Pathfinder 2e content from Archives of Nethys (AoN); the offline synthetic `toy` provider exercises the backend-neutral contract.

Preserve the search-then-details workflow: each active category exposes compact search results and a separate full-text details tool. Software is MIT-licensed; retrieved rules have separate licensing and attribution requirements in `docs/providers/pf2e.md`.

## Architecture & Data Flow

1. `src/index.ts` snapshots and validates environment configuration, selects a provider through `src/registry.ts`, generates a fixed tool list, checks its serialized size, and connects `StdioServerTransport`. Provider construction must be synchronous and perform no network I/O; discovery works without AoN.
2. Providers declare categories, filters, capabilities, tiers, and routing examples in metadata. `src/tools/` generates names, descriptions, strict schemas, and search/details handlers. Success includes structured content plus compatibility text; failures use explicit MCP error results.
3. `src/provider/types.ts` is the import-free neutral contract. `src/registry.ts` is the designated concrete-provider import boundary outside providers. Shared code must not depend on PF2e/toy implementations, and providers must not import each other; ESLint enforces specific dependency zones.
4. PF2e calls flow through `provider/pf2e/index.ts` (orchestration, caches, cursors), `client.ts` (AoN Elasticsearch queries/validation), and `map.ts` (neutral entries). All outbound requests use `src/http.ts` for identity, throttling, concurrency, deadlines, response limits, and explicit errors.
5. Content caches are bounded process-local LRUs without TTL or disk storage. `src/pagination.ts` separately stores bounded, expiring opaque cursors tied to the original search context. Restart invalidates both kinds of state.

Default PF2e search excludes superseded and suppressed content. Direct legacy details remain visible with `canonicity: "legacy"` and `supersededBy` when available. Keep the rotating-safe `aon` index alias; continuations detect concrete-index changes. A short or empty page is not terminal while `nextCursor` exists.

## Key Directories

- `src/provider/`: neutral contract, live PF2e adapter, and synthetic toy implementation.
- `src/tools/`: metadata-driven MCP registration, schemas, routing descriptions, and result formatting.
- `test/unit/`, `test/integration/`: deterministic behavioral tests and built-server stdio contracts.
- `test/package/`, `test/live/`, `test/setup/`: installed-artifact checks, opt-in AoN drift checks, and unit-process network isolation.
- `docs/`: provider policy, manual model/tool-routing acceptance, and maintainer release procedures.
- `scripts/`: release orchestration and invariant-focused mutation QA.
- `.github/workflows/`: cross-platform CI and version-tag/manual release automation.

Do not hand-edit generated `dist/`, dependency state, or `.omc/`, `.idea/`, `.codegraph/` content. Keep release artifacts and tarballs out of commits.

## Development Commands

```powershell
npm ci                      # reproducible install from package-lock.json
npm run build               # emit src/ to dist/ and mark entry executable
npm run typecheck           # check source and tests through both tsconfigs
npm run lint                # ESLint, including stdout and dependency-zone rules
npm test                    # compile, then run unit + integration projects
npm run test:watch          # unit project only
npm run test:package        # pack, production-install, launch outside checkout
npm run test:live           # opt-in real AoN compatibility checks
npm run test:mutation       # Python harness; temporarily rewrites source
npm start                   # node dist/index.js; build first
npm run inspector           # MCP Inspector against built entry
npm run release:check       # release dry run; writes artifacts and queries npm
```

Focused unit example: `npx vitest run --project unit test/unit/cache.test.ts`. Direct integration runs require a current build; `npm test` compiles automatically. `npm pack` cleans and rebuilds `dist/` through `prepack`.

## Code Conventions & Common Patterns

- Use strict TypeScript ESM with explicit `.js` import suffixes and type-only imports where appropriate (`NodeNext`, `verbatimModuleSyntax`). Follow surrounding formatting; no formatter is configured.
- `.gitattributes` enforces LF checkout for `*.mjs`; keep shebang modules LF. Verify Windows checkout behavior with a fresh Git checkout using `core.autocrlf=true`, not a locally copied tree.
- Prefer domain names such as `Provider`, `Client`, `Descriptor`, `Entry`, and `Result`, readonly metadata, and ECMAScript `#private` mutable state. Tools follow `<system>_search_<category>` and `<system>_get_<category>_details`.
- Add provider factories and owned configuration keys in `src/registry.ts`. Keep category/filter/capability/routing metadata provider-owned; do not add game-specific branches to shared tool generation. Declared local filters must apply before limiting results.
- Centralize shared budgets and limits in `src/constants.ts`; keep provider-specific query/relevance constants inside the adapter.
- Validate boundaries: reject unknown filters, malformed booleans, invalid IDs/cursors, oversized inputs, and malformed upstream responses. Do not clamp or silently ignore invalid arguments.
- Fail explicitly: backend/network failures are not empty search results. Preserve upstream status only for genuine upstream errors, and mark degraded, legacy, and truncated results visibly.
- Stdout is the JSON-RPC transport. Never use `console.log` or write diagnostics to stdout; use stderr.
- Tool handlers create one whole-call `Deadline`, propagate its `AbortSignal` and remaining budget through sequential requests, and dispose it in `finally`. Preserve AoN politeness and contact-identifying `USER_AGENT`; do not introduce automatic retries or extra traffic casually.
- Inject side effects for deterministic checks: `HttpClient` accepts fetch/clock/sleep functions; `Pf2eProvider` accepts HTTP/cache/cursor dependencies; cursor storage accepts a clock. Prefer injection over global mocks.
- Include every result-affecting input in collision-safe cache keys. Cursors bind query, filters, limit, and policy context; reject foreign, expired, evicted, or mismatched tokens rather than restarting silently.
- Mapping must retain defensive response validation, AoN same-origin link handling, preferred plain-text fields, truncation markers, and attribution. Search must stay compact rather than return full rules text.

## Important Files

- `src/index.ts`, `src/config.ts`, `src/registry.ts`: startup, environment validation, and provider composition.
- `src/provider/types.ts`: zero-import public contract and `BackendError`.
- `src/provider/pf2e/{index,client,map}.ts`: orchestration, AoN transport/query handling, and document mapping.
- `src/http.ts`, `src/cache.ts`, `src/pagination.ts`, `src/constants.ts`: shared runtime policies and bounded state.
- `package.json`, `package-lock.json`: scripts, runtime/dependency declarations, executable and packed-file allowlist.
- `tsconfig.json`, `tsconfig.test.json`: production emit and source-plus-test no-emit checks. The test config must override inherited `rootDir` and `exclude`.
- `eslint.config.js`, `vitest.workspace.ts`: protocol/dependency restrictions and four test project boundaries.
- `README.md`, `docs/providers/pf2e.md`: installation, runtime configuration, Remaster policy, and attribution.
- `docs/acceptance-scenarios.md`, `docs/release-runbook.md`: model-routing acceptance and release operations.
- `scripts/release.mjs`, `scripts/release.d.mts`: release implementation and declarations used by TypeScript tests.

## Runtime/Tooling Preferences

Use npm 11.16.0 (`npm install --global npm@11.16.0`) and the committed lockfile, not Bun or an alternate package manager; `packageManager` pins this npm version. Node >=22.19.0 is declared for runtime and tooling; supported lines are Node 22 (22.19.0+) and 24, with Node 24 preferred. MCP Inspector 2.3 and its nested undici 8 require this floor. CI tests the exact minimum Node 22.19.0 and Node 24 on Ubuntu and Windows, using npm 11.16.0 throughout. Node 20 is no longer supported.

The project is ESM and runs from `dist/index.js`. Local MCP clients can launch `node` with an absolute built-entry path. Packaging targets `@orinnadiak/mcp-rpg-tools` with the `mcp-rpg-tools` executable; do not assume registry publication merely from package metadata. Consult `README.md` for installation status and Windows launcher examples.

Configuration is environment-based and fixed at startup: `GAME_SYSTEM` defaults to `pf2e`; valid systems are `pf2e` and `toy`. PF2e owns `PF2E_INCLUDE_EXTENDED` and `INCLUDE_LEGACY`. Consult toy source/tests for fixture-only flags. Changing systems or tool tiers requires restart. There is no application dev server, source watcher, disk cache, or offline PF2e mode.

Optional mutation QA requires Python. Release publication additionally uses npm and the GitHub CLI; follow the runbook rather than treating the dry run as an offline or side-effect-free check.

## Testing & QA

Vitest has four projects in `vitest.workspace.ts`:

- **unit**: `test/unit/**/*.test.ts`. `test/setup/no-network.ts` disables unstubbed Undici connections in this process, not spawned children. Use inline representative fixtures and injected fetch/clock/sleep dependencies.
- **integration**: `test/integration/**/*.test.ts`. Exercises compiled `dist/index.js` over real JSON-RPC/stdio through `stdio-client.ts`; close every spawned server in `finally`. Keep stdout valid JSON-RPC and diagnostics on stderr.
- **package**: `test/package/**/*.test.ts`. Run through `npm run test:package`; it packs, installs production dependencies in a temporary path outside the checkout, and launches both installed JS and the executable. This can require npm/cache/registry access.
- **live**: `test/live/**/*.test.ts`. Deliberate real AoN traffic for schema/index drift; excluded from default tests and normal CI gates. Keep requests small and courteous.

For focused changes, run relevant tests first, then `npm run typecheck`, `npm run lint`, and `npm test`. CI also runs installed-package checks and a release dry run. There is no configured coverage threshold; test caller-visible contracts, boundaries, errors, cache/cursor invariants, and transitions rather than implementation trivia. Fixtures should include realistic preferred upstream fields, not only fallbacks.

For load-bearing invariant changes, consider `npm run test:mutation`. It temporarily edits actual source and uses a shared report file: never run concurrently with source edits or another harness. Missing mutation anchors are failures; fix them rather than accepting skipped rows. Review its `shell=True` subprocess invocation before use on POSIX.

Tool-routing or answer-quality changes also require an actual MCP-client session using `docs/acceptance-scenarios.md`; record invoked tools, IDs, transcript evidence, and commit SHA. Data tests alone do not prove model routing, and historical acceptance notes are not fresh verification.
