# Release Runbook

This guide describes the release process for `@orinnadiak/mcp-rpg-tools`, covering versioning, tagging, CI/CD automation, npm trusted publishing (OIDC), dist-tag policies, failure recovery, and distribution limitations.

---

## 1. Overview and Architecture

Releases are automated via GitHub Actions workflows and orchestrated by [`scripts/release.mjs`](../scripts/release.mjs):

- **CI (`.github/workflows/ci.yml`)**: Triggered on all Pull Requests and pushes to `main`. Runs typecheck, lint, build, offline unit and integration tests across the exact minimum Node 22.19.0 and Node 24 on Linux and Windows, followed by packaging smoke tests outside the checkout and a release dry-run check. All jobs install npm 11.16.0 before `npm ci`; dry-run and release jobs use Node 22.19.0. Operates with read-only permissions (`contents: read`) and has no registry publish access.
- **Release (`.github/workflows/release.yml`)**: Triggered strictly by maintainer-pushed tags matching `v*.*.*` (e.g. `v0.1.0-beta.1`, `v0.2.0-next.0`). Validates that the tag, `package.json` version, and MCP server version match; verifies that the tag commit exists in the history of the default branch (`main`); packs once and tests the tarball outside the checkout; verifies npm checksums; publishes to npm using OIDC trusted publishing; and creates a matching GitHub Release with assets, SHA-256 checksums, and version-pinned configuration instructions.
- **Concurrency**: Release publishing is serialized with `concurrency: group: release-publish` and `cancel-in-progress: false` to prevent race conditions or duplicate publishing.

Runtime and development tooling require Node **22.19.0 or newer**; Node **24** is recommended for local release work. The supported Node lines are **22** (22.19.0+) and **24**. Node 20 is no longer supported: MCP Inspector 2.3 and its nested undici 8 require the new floor. Use the pinned npm **11.16.0** (`npm install --global npm@11.16.0`) with the committed lockfile for reproducible installs.

### GitHub Actions Runtime

Both workflows use [`actions/checkout@v7`](https://github.com/actions/checkout/tree/v7) and [`actions/setup-node@v7`](https://github.com/actions/setup-node/tree/v7), whose action and post-job entry points run on Node 24. This is separate from the application test matrix and runtime floor above. The Node 24 action runtime requires Actions Runner **2.327.1 or newer**; checkout's authenticated Git support inside Docker container actions requires **2.329.0 or newer**. These workflows use GitHub-hosted Ubuntu/Windows runners and do not run container actions.

The migration preserves explicit `cache: 'npm'` and `fetch-depth: 0` in the CI dry-run and release checkouts. setup-node v6 removed `always-auth` (not used here); v7 removed the dummy `NODE_AUTH_TOKEN` fallback. npm 11.16.0 trusted publishing does not require that fallback, and the release step still supplies `NPM_TOKEN` when configured. checkout v7's fork protections concern `pull_request_target`/`workflow_run`, neither of which these workflows use.

After changing action versions, require all five CI jobs to pass and dispatch `release.yml` on the updated ref with `dry_run=true` (never use the publishing default for verification). Inspect setup, npm cache restore/save, and post-job logs for the Node 20 runtime annotation, `DEP0040` (`punycode`), and `DEP0169` (`url.parse()`). If supported actions still emit these warnings, record the affected action version, run/step links, and an upstream issue; do not suppress warnings or change the application Node matrix.

### Linux Runner Image Policy

**Retain `ubuntu-latest` consistently** for the CI Linux matrix, dependent CI release dry run, and Release workflow. Keep both `windows-latest` matrix jobs and Node `['22.19.0', '24']`; all jobs install npm **11.16.0** and print the resolved Node/npm versions. The actual OS, image name/version, and runner version come from each job's **Set up job** log, not the requested label.

This decision addresses [issue #18](https://github.com/BurcinSayin/mcp-rpg-tool/issues/18). The [upstream Ubuntu 26 migration announcement](https://github.com/actions/runner-images/issues/14748) schedules the `ubuntu-latest` rollout for October 19–November 19, 2026. The announcement and historical Ubuntu 24 successes are not Ubuntu 26 compatibility evidence; the explicit-image validation below is.

For future image transitions, temporarily change all three Linux selectors together to the candidate's explicit label on a candidate branch. Require the existing four Linux/Windows Node matrix jobs, installed-package checks, dependent CI dry run, and a Release dispatch explicitly using `dry_run=true` to pass; verify actual images, Node/npm versions, run/job links, and SHAs before restoring `ubuntu-latest` together and validating the final policy again. If the candidate fails, reports another OS, or cannot obtain a runner within 30 minutes, preserve the failure evidence and temporarily pin all three selectors to the last validated image. An announcement, elapsed date, or passing old-image run does not establish candidate compatibility.

#### Historical Ubuntu 24 Baseline — 2026-10-06

These pre-existing successes establish only the old-image baseline. Both jobs requested `ubuntu-latest` and actually used Ubuntu **24.04.5**, image **`ubuntu-24.04`**, version **`20260927.320.1`**, runner **2.337.0**, and Node **22.19.0**. Their npm setup installed **11.16.0** successfully, but did not yet print a post-install version.

| Workflow / job | Tested commit | Observed result |
| --- | --- | --- |
| [CI run](https://github.com/BurcinSayin/mcp-rpg-tool/actions/runs/37457176352) / [Linux Node 22 job](https://github.com/BurcinSayin/mcp-rpg-tool/actions/runs/37457176352/job/112247522829) | `9db1b7948423dbff78688a6cd0227d04d30941ae` | Typecheck, lint, build, 215 unit/integration tests, and installed-package smoke passed. |
| [Release run](https://github.com/BurcinSayin/mcp-rpg-tool/actions/runs/37456928440) / [dry-run job](https://github.com/BurcinSayin/mcp-rpg-tool/actions/runs/37456928440/job/112246715202) | `c0bf7a3d0db8c742512e40e6fa176af7fec8831b` | Explicit `dry_run=true`; verification gate and packaging smoke passed; non-publication completion marker observed. |

#### Explicit Ubuntu 26 Validation — 2026-10-31

Branch head **`f9a400377ef26c3b1065520e1fdaeff042da0d0d`** provisionally requested **`ubuntu-26.04`** at all three selectors. [CI run 41193369738](https://github.com/BurcinSayin/mcp-rpg-tool/actions/runs/41193369738) reports that head SHA and checked out PR merge **`0cd7327347ae99417f9ce9bd670550fcc8732bbf`**, whose parents include the branch head. [Release run 41193652174](https://github.com/BurcinSayin/mcp-rpg-tool/actions/runs/41193652174), dispatched with **`dry_run=true`**, checked out the branch head itself; the branch remained unchanged through completion.

Every Linux job below actually used Ubuntu **26.04.1**, image **`ubuntu-26.04`**, version **`20261025.179.1`**. Both Windows jobs requested **`windows-latest`** and used Windows Server **2025 / 10.0.26100**, image **`windows-2025-vs2026`**, version **`20261021.278.1`**. All six jobs used runner **2.338.2** and printed post-install npm **11.16.0**.

| Job | Resolved Node | Successful checks |
| --- | --- | --- |
| [CI Linux Node 22](https://github.com/BurcinSayin/mcp-rpg-tool/actions/runs/41193369738/job/124514506562) | 22.19.0 | Typecheck, lint, build, 215 unit/integration tests, installed-package smoke. |
| [CI Linux Node 24](https://github.com/BurcinSayin/mcp-rpg-tool/actions/runs/41193369738/job/124514506348) | 24.22.1 | Typecheck, lint, build, 215 unit/integration tests, installed-package smoke. |
| [CI Windows Node 22](https://github.com/BurcinSayin/mcp-rpg-tool/actions/runs/41193369738/job/124514506546) | 22.19.0 | Typecheck, lint, build, 215 unit/integration tests, installed-package smoke. |
| [CI Windows Node 24](https://github.com/BurcinSayin/mcp-rpg-tool/actions/runs/41193369738/job/124514506493) | 24.22.1 | Typecheck, lint, build, 215 unit/integration tests, installed-package smoke. |
| [CI release dry run](https://github.com/BurcinSayin/mcp-rpg-tool/actions/runs/41193369738/job/124515147903) | 22.19.0 | `npm run release:check`: packaging smoke and non-publication completion. |
| [Release dry run](https://github.com/BurcinSayin/mcp-rpg-tool/actions/runs/41193652174/job/124515366766) | 22.19.0 | Typecheck, lint, 215 unit/integration tests; explicit dry-run path, packaging smoke and non-publication completion. |

#### Final `ubuntu-latest` Policy Verification — 2026-10-31

Branch head **`27f4c2e4db61b023e4582a2775b0e94bdbd5dc70`** restored all three Linux selectors to **`ubuntu-latest`**, with comments pointing here. [CI run 41193800610](https://github.com/BurcinSayin/mcp-rpg-tool/actions/runs/41193800610) reports that head SHA and checked out PR merge **`9cd9cd5e8c6ad60b17ce121e39f7d143ca007896`**, whose parents include the branch head. [Release run 41193996851](https://github.com/BurcinSayin/mcp-rpg-tool/actions/runs/41193996851), dispatched with **`dry_run=true`**, checked out the branch head itself; the branch remained unchanged through completion. The subsequent evidence-only documentation commit does not change either workflow.

Every Linux job below actually used Ubuntu **24.04.5**, image **`ubuntu-24.04`**, version **`20261025.353.1`**, despite requesting `ubuntu-latest`. Both Windows jobs retained **`windows-latest`** and used Windows Server **2025 / 10.0.26100**, image **`windows-2025-vs2026`**, version **`20261030.294.1`**. All six jobs used runner **2.338.2** and printed post-install npm **11.16.0**. These final-policy runs do not replace the explicit Ubuntu 26 proof above.

| Job | Resolved Node | Successful checks |
| --- | --- | --- |
| [CI Linux Node 22](https://github.com/BurcinSayin/mcp-rpg-tool/actions/runs/41193800610/job/124515795109) | 22.19.0 | Typecheck, lint, build, 215 unit/integration tests, installed-package smoke. |
| [CI Linux Node 24](https://github.com/BurcinSayin/mcp-rpg-tool/actions/runs/41193800610/job/124515795113) | 24.22.1 | Typecheck, lint, build, 215 unit/integration tests, installed-package smoke. |
| [CI Windows Node 22](https://github.com/BurcinSayin/mcp-rpg-tool/actions/runs/41193800610/job/124515795068) | 22.19.0 | Typecheck, lint, build, 215 unit/integration tests, installed-package smoke. |
| [CI Windows Node 24](https://github.com/BurcinSayin/mcp-rpg-tool/actions/runs/41193800610/job/124515794936) | 24.22.2 | Typecheck, lint, build, 215 unit/integration tests, installed-package smoke. |
| [CI release dry run](https://github.com/BurcinSayin/mcp-rpg-tool/actions/runs/41193800610/job/124516237206) | 22.19.0 | `npm run release:check`: packaging smoke and non-publication completion. |
| [Release dry run](https://github.com/BurcinSayin/mcp-rpg-tool/actions/runs/41193996851/job/124516370425) | 22.19.0 | Typecheck, lint, 215 unit/integration tests; explicit dry-run path, packaging smoke and non-publication completion. |

**Installed-runtime evidence:** each matrix job ran the unchanged `test/package/artifact.test.ts` through `npm run test:package`. It installs a production-only tarball outside the checkout, launches the installed JS entry and npm executable, lists `toy_search_widget` / `toy_get_widget_details`, and calls details for `widget-1`, asserting `{ id: 'widget-1', body: 'A small brass widget. Turns clockwise.' }` without `isError: true`. Both release dry-run paths also execute this package smoke test.

**Non-publication evidence and limits:** all four fresh dry-run jobs, plus the historical Release job, printed `[release] Packaging smoke test passed.` and `[release] Dry run complete. No publish or GitHub Release performed.` CI executed `release:check` (`--dry-run`); both fresh Release dispatch logs show the `if [ "true" = "true" ]` branch selecting `--dry-run`. The script returns from that branch before npm publication or GitHub Release creation. Each recorded dry run emitted ancestry and already-published/different-checksum notices, permitted by existing dry-run semantics; these are not successful real-publication gates. Final `ubuntu-latest` jobs also retained the upstream migration notice rather than suppressing it. No tags were created, moved, deleted, or pushed, and no real publish command was invoked for this validation.

### Tag Selection and Dry Runs

- An explicit `--tag` takes precedence and must match `v` plus the package and server versions.
- On an actual GitHub tag ref, the script uses and validates that tag even with `--dry-run`.
- Without an explicit tag, GitHub branch/PR dry runs synthesize `v` plus the package version. Local runs and non-publishing `--validate`/`--pack` runs retain the package-version fallback.
- Real publishing on a GitHub branch or other non-tag ref is rejected before packing unless an explicit matching `--tag` is supplied.

A manual release workflow dispatch on a branch with `dry_run=true` works for packaging verification; use a matching tag ref for the normal real-publish workflow. No workflow-specific tag override is needed for branch dry runs.

Dry runs still validate the selected tag and versions, pack the tarball, write metadata, run the packaging smoke test, and query npm. They do not run typechecking, linting, or unit/integration tests; run those separately. Ancestry failures and published checksum mismatches are warnings in dry-run mode rather than failed gates.

---

## 2. Initial Setup and Package Bootstrap (One-Time Maintainer Configuration)

### 2.1. npm Namespace Ownership

The package is published under the `@orinnadiak` scope:
- Package: `@orinnadiak/mcp-rpg-tools`
- Access: `public`

Ensure you are logged into an npm account with ownership of the `@orinnadiak` organization or scope on [npmjs.com](https://www.npmjs.com).

### 2.2. npm Trusted Publishing (OIDC)

npm supports Trusted Publishing via GitHub Actions OpenID Connect (OIDC). When configured, the release workflow exchanges a short-lived OIDC token (`permissions: id-token: write`) to publish packages with verifiable build provenance (`--provenance`), eliminating the need for long-lived static tokens.

**Configuring Trusted Publishing on npmjs.com:**
1. Navigate to the package settings on npm:
   `https://www.npmjs.com/package/@orinnadiak/mcp-rpg-tools/access`
2. Under **Publishing Access** / **Trusted Publishers**, click **Connect GitHub Actions**.
3. Fill in the repository details:
   - **Repository Owner**: `BurcinSayin`
   - **Repository Name**: `mcp-rpg-tool`
   - **Workflow Filename**: `release.yml`
   - **Environment**: (leave blank unless using a GitHub environment)
4. Save the configuration.

### 2.3. Bootstrap / Fallback Token (`NPM_TOKEN`)

If you are publishing a new package for the very first time before its settings page exists on npmjs.com, configure an npm automation token in the GitHub repository secrets:
1. Generate an npm Access Token (Automation type) on [npmjs.com/settings/tokens](https://www.npmjs.com/settings/tokens).
2. In the GitHub repository settings, go to **Settings** > **Secrets and variables** > **Actions**.
3. Create a repository secret named `NPM_TOKEN` containing the automation token.
4. The workflow will use `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` as a fallback or bootstrap mechanism, while still utilizing OIDC provenance.

---

## 3. Versioning and Dist-Tag Policy

The project adheres to [Semantic Versioning 2.0.0](https://semver.org/).

### 3.1. Stable Releases vs. Prereleases

- **Beta Versions** (e.g. `0.1.0-beta.1`; first prerelease identifier exactly `beta`):
  - npm dist-tag: `beta`
  - GitHub Release: Flagged as prerelease (`prerelease: true`)
- **Other Prereleases** (e.g. `0.1.0-next.1`, `0.1.0-alpha.1`, `0.1.0-rc.1`):
  - npm dist-tag: `next`
  - GitHub Release: Flagged as prerelease (`prerelease: true`)
- **Future Stable Versions** (e.g. `0.1.0`, `1.0.0`):
  - npm dist-tag: `latest`
  - GitHub Release: Standard release (`prerelease: false`)

**Critical Invariant**: Reserve npm's `latest` dist-tag for stable releases.
Consumers should explicitly select a beta version or the `beta` channel.
After publication, check `npm view @orinnadiak/mcp-rpg-tools dist-tags --json`.
If `latest` points to a beta and no stable release exists, remove only that tag
with `npm dist-tag rm @orinnadiak/mcp-rpg-tools latest`; do not unpublish the version.
If a stable release exists, restore `latest` to that stable version instead.
The checksum-matching recovery path skips publication and does not repair dist-tags.

The first beta, `0.1.0-beta.1`, is published; subsequent betas increment the
counter (`0.1.0-beta.2`, etc.). `publishConfig.tag: "beta"` and an explicit
`--tag beta` select the intended prerelease channel for manual publication.

npm 11.16.0's publication preview can still print `tag latest` when the tag comes
from `publishConfig`: its notice uses the original config value, while effective
publication options use `beta`. Do not treat that preview line as proof of the
effective channel. The release script passes `--tag beta` explicitly.

Stable promotion is a separate maintainer decision: set the stable version in
`package.json` and the lockfile, remove `publishConfig.tag: "beta"` before packing,
and let the existing release script select `latest`. Do not perform these future
promotion steps as part of beta preparation.

---

## 4. Release Procedure (Step-by-Step)

### Step 1: Bump Version on `main`

All releases must originate from commits on the default branch (`main`). Releases from feature branches or detached unmerged commits are rejected by the workflow.

1. Ensure your local branch is on `main` and up-to-date:
   ```sh
   git checkout main
   git pull origin main
   ```
2. Update the version in `package.json`:
   ```sh
   npm version <new-version> --no-git-tag-version
   ```
   *(Next beta example: `npm version 0.1.0-beta.2 --no-git-tag-version`; this updates both package and lockfile versions.)*
3. Verify local build and test suites pass:
   ```sh
   npm run typecheck
   npm run lint
   npm test
   npm run test:package
   ```
4. Run a local release dry-run:
   ```sh
   npm run release:check
   ```
   This will pack the tarball, run the outside-the-checkout packaging smoke test, compute checksums, inspect npm registry status, and print the generated release notes.
5. Commit the version bump to `main` and push:
   ```sh
   git commit -am "chore: bump version to <new-version>"
   git push origin main
   ```

### Step 2: Tag and Push

Create an annotated git tag prefixed with `v` corresponding to the exact version in `package.json`:

```sh
git tag -a v<new-version> -m "Release v<new-version>"
git push origin v<new-version>
```

*(Next beta example: `git tag -a v0.1.0-beta.2 -m "Release v0.1.0-beta.2" && git push origin v0.1.0-beta.2`; tagging and pushing trigger publication. Do not recreate the existing `v0.1.0-beta.1` tag.)*

### Step 3: Monitor Workflow

1. Open GitHub Actions in the repository:
   `https://github.com/BurcinSayin/mcp-rpg-tool/actions/workflows/release.yml`
2. The workflow will:
   - Validate that `tag === 'v' + package.json version === 'v' + SERVER_VERSION`.
   - Verify that the commit is an ancestor of `origin/main`.
   - Run typecheck, lint, and offline tests.
   - Build and pack the single distribution tarball (`artifacts/release/*.tgz`).
   - Run the packaging smoke test outside the checkout with only production dependencies.
   - Publish the current beta to npm under `beta` with provenance (`next` for other prereleases; `latest` for future stable releases).
   - Create a GitHub Release with the tarball, `.sha256` checksum, and release notes.

---

## 5. Failure Recovery and Re-Run Invariants

A key design requirement is safe recovery from partial completion (for example, if npm publishing succeeds but GitHub Release creation fails due to a network or API timeout):

### 5.1. Immutable npm Versions

npm package versions are strictly immutable. Once `0.2.0` is published to npm, npm permanently rejects any attempt to overwrite it (`EPUBLISHCONFLICT`).

### 5.2. Checksum Verification on Re-Run

When re-running the release workflow:
1. The script queries npm:
   ```sh
   npm view @orinnadiak/mcp-rpg-tools@<version> dist.shasum --json
   ```
2. **If Already Published with Matching Checksum**:
   - The workflow detects that the artifact already on npm is bit-for-bit identical to the locally verified tarball.
   - It safely skips the `npm publish` step with a logged notice.
   - It resumes execution and creates or updates the GitHub Release.
3. **If Already Published with Differing Checksum**:
   - The workflow terminates immediately with a fatal error:
     ```
     [release] FATAL: Package @orinnadiak/mcp-rpg-tools@<version> is already published on npm with a DIFFERENT checksum. npm versions are immutable and cannot be overwritten.
     ```
   - This prevents corrupting releases or publishing mismatched artifacts to GitHub.
4. **Resolution for a Failed Release with Differing Checksum**:
   - If an artifact on npm was published with differing content (e.g. from an uncommitted local build), you **cannot** re-use that version number.
   - Bump the version to the next patch or prerelease (e.g. `0.2.1`), push to `main`, and cut a new tag `v0.2.1`.

---

## 6. Public Distribution

The [GitHub source repository](https://github.com/BurcinSayin/mcp-rpg-tool)
and the [npm package](https://www.npmjs.com/package/@orinnadiak/mcp-rpg-tools)
are public. The first beta is available as
[`v0.1.0-beta.1`](https://github.com/BurcinSayin/mcp-rpg-tool/releases/tag/v0.1.0-beta.1).

1. **GitHub Release Assets**: Published releases include the `.tgz` package and
   its `.sha256` checksum. Public users can download them without GitHub
   authentication. Verify the checksum before using a downloaded artifact.
2. **npm Installation**: Consumers do not need a repository checkout, GitHub
   credentials, or a TypeScript compiler. Prefer exact-version configurations:
   - Linux / macOS: `npx --yes @orinnadiak/mcp-rpg-tools@0.1.0-beta.1`
   - Windows: `cmd` with `/d /s /c npx --yes @orinnadiak/mcp-rpg-tools@0.1.0-beta.1`
   - Global install: `npm install --global @orinnadiak/mcp-rpg-tools@0.1.0-beta.1`
   - Use `@beta` instead of the exact version only when opting into the moving beta channel.
3. **Provenance**: Public repository visibility permits GitHub Actions provenance
   for future workflow publications when npm authentication is configured.
   A terminal-published artifact does not acquire GitHub Actions provenance when
   the workflow later skips publication and creates the GitHub Release.
