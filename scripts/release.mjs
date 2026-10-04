#!/usr/bin/env node
import { execFile } from 'node:child_process';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..');

/**
 * Semver specification regex (SemVer 2.0.0).
 */
const SEMVER_REGEX =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * Parses a semantic version string.
 * @param {string} versionStr
 * @returns {{ major: number, minor: number, patch: number, prerelease: string | undefined, build: string | undefined } | null}
 */
export function parseSemver(versionStr) {
  if (typeof versionStr !== 'string') return null;
  const match = SEMVER_REGEX.exec(versionStr.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || undefined,
    build: match[5] || undefined,
  };
}

/**
 * Validates a release tag against package.json and MCP server version.
 * @param {string} tag
 * @param {string} packageVersion
 * @param {string} [serverVersion]
 * @returns {{ tag: string, version: string, isPrerelease: boolean, distTag: string }}
 */
export function validateReleaseTag(tag, packageVersion, serverVersion) {
  if (typeof tag !== 'string' || !tag.startsWith('v')) {
    throw new Error(`Release tag must start with 'v' (e.g. 'v0.1.0'), received: "${tag}"`);
  }

  const versionFromTag = tag.slice(1);
  const parsedTag = parseSemver(versionFromTag);
  if (!parsedTag) {
    throw new Error(`Release tag "${tag}" does not specify a valid semantic version`);
  }

  const parsedPkg = parseSemver(packageVersion);
  if (!parsedPkg) {
    throw new Error(`package.json version "${packageVersion}" is not a valid semantic version`);
  }

  if (versionFromTag !== packageVersion) {
    throw new Error(
      `Tag version "${versionFromTag}" does not match package.json version "${packageVersion}"`
    );
  }

  if (serverVersion !== undefined) {
    if (serverVersion !== packageVersion) {
      throw new Error(
        `package.json version "${packageVersion}" does not match MCP server version "${serverVersion}"`
      );
    }
  }

  const isPrerelease = Boolean(parsedTag.prerelease);
  const distTag = !isPrerelease ? 'latest'
    : parsedTag.prerelease?.split('.')[0] === 'beta' ? 'beta' : 'next';

  return {
    tag,
    version: versionFromTag,
    isPrerelease,
    distTag,
  };
}

/**
 * Selects and validates a release tag without treating branch/PR names as tags.
 * @param {string} packageVersion
 * @param {{
 *   explicitTag?: string,
 *   serverVersion?: string,
 *   githubActions?: string,
 *   githubRefType?: string,
 *   githubRefName?: string,
 *   isDryRun?: boolean,
 *   isNonPublishing?: boolean,
 * }} [options]
 * @returns {{ tag: string, version: string, isPrerelease: boolean, distTag: string }}
 */
export function resolveReleaseTag(packageVersion, options = {}) {
  const {
    explicitTag,
    serverVersion,
    githubActions,
    githubRefType,
    githubRefName,
    isDryRun = false,
    isNonPublishing = false,
  } = options;

  let tag;
  if (explicitTag !== undefined) {
    tag = explicitTag;
  } else if (githubRefType === 'tag') {
    tag = githubRefName;
  } else {
    if (githubActions === 'true' && !isDryRun && !isNonPublishing) {
      throw new Error('GitHub publication requires a tag ref or an explicit --tag.');
    }
    tag = `v${packageVersion}`;
  }

  return validateReleaseTag(tag, packageVersion, serverVersion);
}

/**
 * Verifies that the specified git commit/ref is in the history of the default branch.
 * @param {string} [gitRef='HEAD']
 * @param {string} [defaultBranch='main']
 * @param {(cmd: string, args: string[], opts?: object) => Promise<{ stdout: string, stderr: string }>} [execFn]
 */
export async function verifyDefaultBranchAncestry(
  gitRef = 'HEAD',
  defaultBranch = 'main',
  execFn = execFileAsync
) {
  // Check against origin/<defaultBranch> first, then fallback to local <defaultBranch>
  const candidateBranches = [`origin/${defaultBranch}`, defaultBranch];
  let targetBranch = null;

  for (const branch of candidateBranches) {
    try {
      await execFn('git', ['rev-parse', '--verify', branch], { cwd: PROJECT_ROOT });
      targetBranch = branch;
      break;
    } catch {
      // Branch ref not found, continue searching
    }
  }

  if (!targetBranch) {
    throw new Error(
      `Could not find default branch ref (checked ${candidateBranches.join(', ')}). Ensure git history is available.`
    );
  }

  try {
    await execFn('git', ['merge-base', '--is-ancestor', gitRef, targetBranch], {
      cwd: PROJECT_ROOT,
    });
  } catch {
    throw new Error(
      `Commit "${gitRef}" is not an ancestor of default branch "${targetBranch}". Releases must only be cut from commits on the default branch.`
    );
  }

  return { gitRef, targetBranch };
}

/**
 * Computes SHA-256 and SHA-1 hashes of a file.
 * @param {string} filePath
 * @returns {{ sha256: string, shasum: string, sizeBytes: number }}
 */
export function computeFileChecksums(filePath) {
  const content = readFileSync(filePath);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const shasum = createHash('sha1').update(content).digest('hex');
  return { sha256, shasum, sizeBytes: content.length };
}

/**
 * Generates release notes markdown with installation examples and checksums.
 * @param {{
 *   version: string,
 *   packageName: string,
 *   tarballFilename: string,
 *   sha256: string,
 *   isPrerelease: boolean,
 *   distTag: string,
 * }} options
 * @returns {string}
 */
export function generateReleaseNotes({
  version,
  packageName,
  tarballFilename,
  sha256,
  isPrerelease,
  distTag,
}) {
  const lines = [
    `# Release v${version}`,
    '',
  ];

  if (isPrerelease) {
    lines.push(
      `> [!IMPORTANT]`,
      `> **Prerelease Distribution**: This is a prerelease version published to npm under the \`${distTag}\` tag.`,
      `> It does not replace the stable \`latest\` dist-tag.`,
      ''
    );
  }

  lines.push(
    '## MCP Client Configuration',
    '',
    `Configure your AI assistant or MCP client using this version:`,
    '',
    '### Linux / macOS',
    '```json',
    '{',
    '  "mcpServers": {',
    '    "rpg-tools": {',
    '      "command": "npx",',
    `        "args": ["--yes", "${packageName}@${version}"]`,
    '    }',
    '  }',
    '}',
    '```',
    '',
    '### Windows',
    '```json',
    '{',
    '  "mcpServers": {',
    '    "rpg-tools": {',
    '      "command": "cmd",',
    `        "args": ["/d", "/s", "/c", "npx --yes ${packageName}@${version}"]`,
    '    }',
    '  }',
    '}',
    '```',
    '',
    'Alternatively, install globally:',
    '```sh',
    `npm install --global ${packageName}@${version}`,
    'mcp-rpg-tools',
    '```',
    '',
    '## Verified Package Artifact',
    '',
    '| Asset | SHA-256 Checksum |',
    '|---|---|',
    `| \`${tarballFilename}\` | \`${sha256}\` |`,
    '',
    '## Repository & Distribution Notice',
    '',
    '> [!NOTE]',
    '> This source repository is private; direct GitHub Release asset downloads require GitHub repository authorization.',
    `> Public consumers should install or launch via the public npm package registry using \`npx --yes ${packageName}@${version}\`.`,
    ''
  );

  return lines.join('\n');
}

/**
 * Checks whether an npm package version is already published, and verifies its shasum.
 * @param {string} packageName
 * @param {string} version
 * @param {string} localShasum
 * @param {(cmd: string, args: string[], opts?: object) => Promise<{ stdout: string, stderr: string }>} [execFn]
 * @returns {Promise<
 *   | { status: 'not_published' }
 *   | { status: 'already_published_match', publishedShasum: string }
 *   | { status: 'already_published_mismatch', publishedShasum: string, localShasum: string }
 * >}
 */
export async function checkNpmPublicationStatus(
  packageName,
  version,
  localShasum,
  execFn = execFileAsync
) {
  try {
    const { stdout } = await execFn(
      'npm',
      ['view', `${packageName}@${version}`, 'dist.shasum', '--json'],
      { cwd: PROJECT_ROOT }
    );

    const parsed = stdout.trim() ? JSON.parse(stdout.trim()) : null;
    const publishedShasum = typeof parsed === 'string' ? parsed : null;

    if (!publishedShasum) {
      return { status: 'not_published' };
    }

    if (publishedShasum === localShasum) {
      return { status: 'already_published_match', publishedShasum };
    }

    return { status: 'already_published_mismatch', publishedShasum, localShasum };
  } catch (error) {
    const message = String(error);
    if (message.includes('E404') || message.includes('404') || message.includes('Not found')) {
      return { status: 'not_published' };
    }
    // If command failed due to unauthenticated query on non-existing private package
    return { status: 'not_published' };
  }
}

/**
 * Packs the npm package to a destination directory.
 * @param {string} [destinationDir]
 * @param {(cmd: string, args: string[], opts?: object) => Promise<{ stdout: string, stderr: string }>} [execFn]
 * @returns {Promise<{ filename: string, filePath: string, sha256: string, shasum: string, sizeBytes: number }>}
 */
export async function packPackage(destinationDir, execFn = execFileAsync) {
  const dest = destinationDir || path.join(PROJECT_ROOT, 'artifacts', 'release');
  mkdirSync(dest, { recursive: true });

  const { stdout } = await execFn(
    'npm',
    ['pack', '--json', '--pack-destination', dest],
    { cwd: PROJECT_ROOT }
  );

  const parsed = JSON.parse(stdout.trim());
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!entry || !entry.filename) {
    throw new Error(`npm pack did not return expected metadata: ${stdout}`);
  }

  const filePath = path.join(dest, entry.filename);
  const checksums = computeFileChecksums(filePath);

  return {
    filename: entry.filename,
    filePath,
    ...checksums,
  };
}

/**
 * Main release CLI orchestrator.
 */
export async function main(argv = process.argv.slice(2)) {
  const args = new Set(argv);
  const isDryRun = args.has('--dry-run');
  const isValidateOnly = args.has('--validate');
  const isPackOnly = args.has('--pack');
  const isPublishOnly = args.has('--publish');
  const isGithubReleaseOnly = args.has('--github-release');

  const pkg = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  const packageName = pkg.name;
  const packageVersion = pkg.version;

  // Read MCP server version from built or source constants
  let serverVersion = packageVersion;
  try {
    const constantsFile = existsSync(path.join(PROJECT_ROOT, 'dist', 'constants.js'))
      ? path.join(PROJECT_ROOT, 'dist', 'constants.js')
      : null;
    if (constantsFile) {
      const constants = await import(pathToFileURL(constantsFile).href);
      if (constants.SERVER_VERSION) {
        serverVersion = constants.SERVER_VERSION;
      }
    }
  } catch {
    // If not built yet, fallback to packageVersion
  }

  const tagArg = argv.find((a, i) => argv[i - 1] === '--tag');
  const validated = resolveReleaseTag(packageVersion, {
    explicitTag: tagArg,
    serverVersion,
    githubActions: process.env.GITHUB_ACTIONS,
    githubRefType: process.env.GITHUB_REF_TYPE,
    githubRefName: process.env.GITHUB_REF_NAME,
    isDryRun,
    isNonPublishing: isValidateOnly || isPackOnly,
  });

  console.error(`[release] Checking release for package ${packageName}`);
  console.error(`[release] Tag: ${validated.tag}, package.json: ${packageVersion}, MCP server: ${serverVersion}`);

  // 1. Validation
  console.error(
    `[release] Tag validation passed. Version: ${validated.version}, Prerelease: ${validated.isPrerelease}, Dist-tag: ${validated.distTag}`
  );

  // 2. Verify branch ancestry (unless skipped for local dry runs or explicitly not in git)
  if (!args.has('--skip-ancestry-check')) {
    try {
      const ancestry = await verifyDefaultBranchAncestry('HEAD', 'main');
      console.error(`[release] Branch ancestry verified against ${ancestry.targetBranch}`);
    } catch (err) {
      if (isDryRun) {
        console.error(`[release] (dry-run notice) Ancestry check warning: ${err.message}`);
      } else {
        throw err;
      }
    }
  }

  if (isValidateOnly) {
    console.error('[release] Validation complete.');
    return;
  }

  // 3. Pack package
  const releaseDir = path.join(PROJECT_ROOT, 'artifacts', 'release');
  console.error(`[release] Packing package to ${releaseDir}...`);
  const packed = await packPackage(releaseDir);
  console.error(`[release] Tarball: ${packed.filename} (${packed.sizeBytes} bytes)`);
  console.error(`[release] SHA-256: ${packed.sha256}`);
  console.error(`[release] SHA-1 (shasum): ${packed.shasum}`);

  // Write SHA-256 checksum file
  const sha256FilePath = `${packed.filePath}.sha256`;
  writeFileSync(sha256FilePath, `${packed.sha256}  ${packed.filename}\n`, 'utf8');

  // 4. Generate release notes
  const releaseNotes = generateReleaseNotes({
    version: validated.version,
    packageName,
    tarballFilename: packed.filename,
    sha256: packed.sha256,
    isPrerelease: validated.isPrerelease,
    distTag: validated.distTag,
  });

  const notesFilePath = path.join(releaseDir, 'RELEASE_NOTES.md');
  writeFileSync(notesFilePath, releaseNotes, 'utf8');
  console.error(`[release] Release notes written to ${notesFilePath}`);

  if (isPackOnly) {
    console.error('[release] Pack complete.');
    return;
  }

  // 5. Run packaging smoke test if requested or during dry-run
  if (isDryRun || args.has('--smoke-test')) {
    console.error('[release] Running installed-artifact MCP smoke test outside checkout...');
    await execFileAsync('npm', ['run', 'test:package'], { cwd: PROJECT_ROOT });
    console.error('[release] Packaging smoke test passed.');
  }

  // 6. Check npm published status (idempotent / recovery check)
  console.error(`[release] Checking publication status on npm registry for ${packageName}@${validated.version}...`);
  const npmStatus = await checkNpmPublicationStatus(packageName, validated.version, packed.shasum);

  if (npmStatus.status === 'already_published_match') {
    console.error(
      `[release] Package ${packageName}@${validated.version} is ALREADY published to npm with matching checksum (${npmStatus.publishedShasum}). Skipping npm publish.`
    );
  } else if (npmStatus.status === 'already_published_mismatch') {
    const mismatchMsg =
      `Package ${packageName}@${validated.version} is already published on npm with a DIFFERENT checksum ` +
      `(npm: ${npmStatus.publishedShasum}, local: ${packed.shasum}). npm versions are immutable and cannot be overwritten.`;
    if (isDryRun) {
      console.error(`[release] (dry-run notice) ${mismatchMsg}`);
    } else {
      throw new Error(`[release] FATAL: ${mismatchMsg}`);
    }
  } else {
    console.error(`[release] Package ${packageName}@${validated.version} is not yet published on npm.`);
  }

  if (isDryRun) {
    console.error('[release] Dry run complete. No publish or GitHub Release performed.');
    console.log(releaseNotes);
    return;
  }

  // 6. Publish to npm
  if (!isGithubReleaseOnly) {
    if (npmStatus.status === 'not_published') {
      console.error(
        `[release] Publishing ${packed.filename} to npm with dist-tag "${validated.distTag}"...`
      );
      const publishArgs = [
        'publish',
        packed.filePath,
        '--access',
        'public',
        '--tag',
        validated.distTag,
      ];
      // Include provenance if in CI environment
      if (process.env.GITHUB_ACTIONS === 'true') {
        publishArgs.push('--provenance');
      }

      await execFileAsync('npm', publishArgs, { cwd: PROJECT_ROOT });
      console.error(`[release] Successfully published ${packageName}@${validated.version} to npm.`);
    }
  }

  if (isPublishOnly) {
    console.error('[release] Publish step complete.');
    return;
  }

  // 7. GitHub Release creation
  console.error(`[release] Creating GitHub Release for ${validated.tag}...`);
  const ghArgs = [
    'release',
    'create',
    validated.tag,
    packed.filePath,
    sha256FilePath,
    '--title',
    validated.tag,
    '--notes-file',
    notesFilePath,
  ];

  if (validated.isPrerelease) {
    ghArgs.push('--prerelease');
  }

  // Check if release already exists
  try {
    await execFileAsync('gh', ['release', 'view', validated.tag], { cwd: PROJECT_ROOT });
    console.error(`[release] GitHub release ${validated.tag} already exists. Uploading assets...`);
    await execFileAsync(
      'gh',
      ['release', 'upload', validated.tag, packed.filePath, sha256FilePath, '--clobber'],
      { cwd: PROJECT_ROOT }
    );
  } catch {
    // Release does not exist, create it
    await execFileAsync('gh', ghArgs, { cwd: PROJECT_ROOT });
  }

  console.error(`[release] GitHub Release ${validated.tag} completed successfully.`);
}

// Execute CLI when invoked directly
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`[release] Error: ${err.message}`);
    process.exit(1);
  });
}
