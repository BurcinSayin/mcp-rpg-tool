# mcp-rpg-tools

An MCP server that gives an AI assistant tabletop RPG rules lookup. It ships
with [Pathfinder 2e](docs/providers/pf2e.md), backed by Archives of Nethys.
The provider guide covers Pathfinder setup, available tools, Remaster handling,
operational considerations, and content attribution.

Tools are generated from the selected game system's categories rather than a
lowest common denominator.

## Requirements

Node **20 or newer**; Node **24** is recommended for new installations.
Pathfinder 2e requires a network connection — see its
[operational notes](docs/providers/pf2e.md#operational-notes).

## Install and configure your MCP client

The selected public npm package is **`@orinnadiak/mcp-rpg-tools`**.
The following pinned configurations are for the **planned first release, 0.1.0**.
Publication is pending: these examples are not yet verified against npm.
Consumers will not need to clone this repository or install a TypeScript compiler.

### Linux

```json
{
  "mcpServers": {
    "rpg-tools": {
      "command": "npx",
      "args": ["--yes", "@orinnadiak/mcp-rpg-tools@0.1.0"]
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
      "args": ["/d", "/s", "/c", "npx --yes @orinnadiak/mcp-rpg-tools@0.1.0"]
    }
  }
}
```

Alternatively, after publication:

```sh
npm install --global @orinnadiak/mcp-rpg-tools@0.1.0
mcp-rpg-tools
```

The global npm executable directory must be on PATH. Windows clients unable to
launch `mcp-rpg-tools.cmd` directly likewise need `cmd` with
`["/d", "/s", "/c", "mcp-rpg-tools"]`.
To upgrade, replace the explicit version and restart the MCP server. Global users
reinstall the desired exact version.

### Release verification and ownership

The repository remains private; publishing makes the shipped JavaScript public.
The owner must verify control of the `orinnadiak` npm namespace. An anonymous
registry 404 does not establish ownership or permission to publish.

The installed-tarball suite passed on Linux x64 with Node **20.0.0**, **20.20.2**,
**22.23.3**, and **24.21.0**, using each runtime's bundled npm. It checks direct
Node execution and npm's installed-bin resolution with a deterministic toy lookup.
The declared Node floor remains `>=20`. Native Windows verification was reported
complete by the owner on 2026-09-27; runtime versions and logs were not supplied.
No macOS support is claimed.
Actual pinned `npx` and global registry-install launches remain unverified until
publication.

Release gates (manual; no publishing automation):

1. Run `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, and
   `npm run test:package`. The package suite is opt-in and may access npm.
   Repeat `npm run test:package` on Linux and native Windows with the Node
   versions above and compatible bundled npm.
2. Authenticate with npm, run `npm whoami --registry https://registry.npmjs.org/`,
   and verify package access and namespace control. Check whether `0.1.0` already
   exists; do not overwrite it or silently choose another version or scope.
3. Pack with lifecycle scripts enabled and retain the verified tarball. `prepack`
   deletes only generated `dist` output and rebuilds JS, declarations, and maps;
   the build marks the CLI executable. Ship only those outputs, package metadata,
   README, `docs/providers/pf2e.md`, and LICENSE — no rules dataset.
4. Only after all gates pass, the owner publishes that exact verified tarball:
   `npm publish <verified-tarball> --access public --registry https://registry.npmjs.org/`.
5. From fresh temporary directories/caches, verify the pinned Linux and Windows
   launch forms above and a global install into a temporary prefix. With
   `GAME_SYSTEM=toy`, check MCP server name `rpg-lookup`, version `0.1.0`,
   `toy_search_widget` and `toy_get_widget_details`, and details for `widget-1`
   returning `A small brass widget. Turns clockwise.`. Check anonymous access at
   `https://registry.npmjs.org/@orinnadiak%2fmcp-rpg-tools`.

Publication is owner-operated and has not been performed by the local tests.

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
then run:

```sh
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
