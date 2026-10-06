# mcp-rpg-tools

An MCP server that gives an AI assistant tabletop RPG rules lookup. It ships
with [Pathfinder 2e](docs/providers/pf2e.md), backed by Archives of Nethys.
The provider guide covers Pathfinder setup, available tools, Remaster handling,
operational considerations, and content attribution.

Tools are generated from the selected game system's categories rather than a
lowest common denominator.

## Requirements

Node **22.19.0 or newer**; supported Node lines are **22** (22.19.0+) and **24**.
Node **24** is recommended for new installations. Node **20** is no longer supported.
Pathfinder 2e requires a network connection — see its
[operational notes](docs/providers/pf2e.md#operational-notes).

## Install and configure your MCP client

The public npm package is
**[`@orinnadiak/mcp-rpg-tools`](https://www.npmjs.com/package/@orinnadiak/mcp-rpg-tools)**.
The current release is **beta, not a production release**. The following pinned
configurations use the published **0.1.0-beta.1**.
Consumers do not need to clone this repository or install a TypeScript compiler.

### Linux

```json
{
  "mcpServers": {
    "rpg-tools": {
      "command": "npx",
      "args": ["--yes", "@orinnadiak/mcp-rpg-tools@0.1.0-beta.1"]
    }
  }
}
```

### Windows

For clients that cannot launch npm's `.cmd` shim directly, use a command shell:

```json
{
  "mcpServers": {
    "rpg-tools": {
      "command": "cmd",
      "args": ["/d", "/s", "/c", "npx --yes @orinnadiak/mcp-rpg-tools@0.1.0-beta.1"]
    }
  }
}
```

Alternatively, install the executable globally:

```sh
npm install --global @orinnadiak/mcp-rpg-tools@0.1.0-beta.1
mcp-rpg-tools
```

The global npm executable directory must be on PATH. Windows clients unable to
launch `mcp-rpg-tools.cmd` directly likewise need `cmd` with
`["/d", "/s", "/c", "mcp-rpg-tools"]`.
To upgrade, replace the explicit version and restart the MCP server. Global users
reinstall the desired exact version.

`@orinnadiak/mcp-rpg-tools@beta` opts into the moving beta channel.
Exact-version configurations above remain the primary examples. No stable release
is available; explicitly select a version or `beta` rather than relying on `latest`.

### Release verification, ownership, and automation

The [source repository](https://github.com/BurcinSayin/mcp-rpg-tool) is public.
The [beta release](https://github.com/BurcinSayin/mcp-rpg-tool/releases/tag/v0.1.0-beta.1)
includes the package tarball and its SHA-256 checksum; public downloads do not
require GitHub authentication.
Releases are automated via GitHub Actions when an annotated semantic-version tag
(e.g. `v0.1.0-beta.2`) is pushed for a commit on `main`. See the
[Release Runbook](docs/release-runbook.md) for version bumps, tagging, npm Trusted
Publishing (OIDC), dist-tags, recovery from partial completion, and public distribution.

CI covers the installed-tarball suite on Linux x64 and Windows with Node **22.19.0**
(the exact supported minimum) and **24**, using npm **11.16.0** on both runtimes. It checks direct Node
execution and npm's installed-bin resolution with a deterministic toy lookup outside
the checkout. The declared Node floor is `>=22.19.0`, matching MCP Inspector's
development-tool requirement.

You can check release packaging and generate metadata locally without publishing:

```powershell
npm run release:check   # dry-run: packs, writes metadata, runs test:package, queries npm
```

This dry run writes artifacts and checks npm publication status, but does not run
typechecking, linting, or unit/integration tests. Run `npm run typecheck`,
`npm run lint`, and `npm test` separately for full verification. Ancestry failures
and published checksum mismatches are warnings in dry-run mode, not failed gates.

Tag selection remains validated in dry-run mode: an explicit `--tag` takes
precedence, and GitHub tag runs use the actual tag. Branch/PR dry runs and local
runs without a tag use `v` plus the package version. A manual release workflow run
on a branch with `dry_run=true` can check packaging; real GitHub publishing
requires a tag ref or an explicit matching `--tag`.

### Environment variables

| Variable | Default | Effect |
|---|---|---|
| `GAME_SYSTEM` | `pf2e` | Which system to load. `pf2e` or `toy`. An unrecognised value exits non-zero and lists the valid ones. |

For provider-specific settings, see the [Pathfinder 2e guide](docs/providers/pf2e.md).

**Changing `GAME_SYSTEM` requires restarting the server.** The tool list is fixed
at startup and the server tells clients so, rather than advertising updates it will
never send.

## Tools

Two per category — search returns compact summaries, details returns one full
entry. The selected system supplies its categories and tool-name prefix; see the
[Pathfinder 2e tool list](docs/providers/pf2e.md#tools) for the default provider.
Search never returns full rules text: the assistant fetches details only for
entries it needs.

Search results may include `nextCursor`. Pass it as `cursor` on the same search
tool with identical query, filters, and limit to retrieve the next page:

```json
{"query":"fire","limit":2}
{"query":"fire","limit":2,"cursor":"<nextCursor from the previous result>"}
```

Omitted `nextCursor` means finished; a short or empty page alone does not. Search
defaults to 10 results (50 for blank-query small closed sets), with a maximum of
50. Details lookup still uses an entry's `id`, not its page cursor.

Cursors are opaque, reusable, and local to one running server. A traversal expires
after 15 minutes; bounded storage may evict it earlier, and restarting invalidates
all cursors. Invalid, expired, or mismatched cursors produce explicit errors:
restart without `cursor`. Pagination is not a point-in-time snapshot: edits
within the same index can change rankings between pages. MCP `tools/list` is unchanged.

Tool names are prefixed with the system even though only one ships today. Running a
second system alongside this one would otherwise collide, and renaming tools later
breaks every saved client config.

## Operational notes

**Content caches are in memory only**, for the lifetime of the process. Restarting
re-fetches everything. Content has no TTL, so a long-running process can serve
stale cached content. Continuation handles have a separate expiry as described above.

**Failures are explicit.** A backend error surfaces as a tool error carrying the
upstream status code. "The service is rate limiting us", "the service is down", and
"that entry does not exist" are different answers and are reported differently.
An empty terminal page means no further matches, never *something went wrong*;
an empty page with `nextCursor` means traversal can continue past skipped records.

The Pathfinder provider's Archives of Nethys request policy is described in its
[provider guide](docs/providers/pf2e.md#operational-notes).

## Attribution and licensing

Project software is licensed under the [MIT License](LICENSE), copyright
2026 mcp-rpg-tools contributors. This does **not** license retrieved rules text;
see the [Pathfinder content notices](docs/providers/pf2e.md#attribution-and-licensing).

## Development

Source builds remain a development alternative: clone the repository with access,
use Node 22.19.0+ (Node 24 recommended) and the pinned npm 11.16.0, then run:

```sh
npm install --global npm@11.16.0
npm ci
npm run build
```

Point a development MCP client at `node` with the absolute path to
`dist/index.js` as its argument; use the same environment settings above.

```powershell
npm run typecheck     # src/ AND test/ -- see below
npm run lint          # includes the import-zone and stdout rules
npm test              # unit + integration, network mechanically disabled
npm run test:live     # opt-in; hits the real API to detect upstream drift
npm run test:package  # opt-in; packs, installs, and launches outside the checkout
npm run test:mutation # breaks each invariant, checks a test notices
npm run release:check # dry-run; packaging/metadata checks, writes artifacts and queries npm
```

`typecheck` runs two configs. The base one excludes `test/`, and vitest transpiles
without typechecking, so for a while nothing in the repo ever typechecked a test
file — which let a broken helper sit there unreported. `tsconfig.test.json` covers
both. Two traps are noted in that file: `extends` inherits `exclude`, which beats
`include` (the first version resolved zero files and reported success), and the
base `rootDir: src` rejects test files outright.

The startup tool-list size guard uses a narrowly typed view of the SDK's private
request-handler map. SDK upgrades must preserve that boundary; the integration
suite exercises rejection of an oversized tool list.

**`test:mutation` is the one worth running before you trust a green suite.** A
passing test proves nothing about whether it *would* fail. Every test this repo's
issue #1 was about passed while the thing it named was broken, and a full-suite
green was exactly the evidence that concealed it. The matrix breaks each invariant
in turn and reports anything no test noticed.

`npm test` runs with undici's net connect disabled, so any request that is not
explicitly stubbed throws. A test cannot pass because a live service happened to be
up.

### Layout

```
src/provider/types.ts     the backend-neutral contract — has zero imports, by rule
src/provider/pf2e/        Archives of Nethys implementation
src/provider/toy/         ~80-line in-memory provider
src/tools/                schema generation, registration, descriptions, results
src/http.ts               the single outbound path: identity, throttle, timeout
src/cache.ts              bounded LRU primitive
src/constants.ts          every tunable number, defined once
```

The toy provider is not a stub. With one real backend shipping, it is what proves
the shared contract stayed backend-neutral: if `types.ts` ever acquires an
Elasticsearch-shaped concept, the toy provider becomes impossible to write and the
build fails. It validates structure, not schema diversity — that needs a second
real backend.

Before calling a change done, run through [docs/acceptance-scenarios.md](docs/acceptance-scenarios.md).
Automated tests prove the data layer is correct; they cannot tell you whether an
assistant picks the right tool.
