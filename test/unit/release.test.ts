import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkNpmPublicationStatus,
  computeFileChecksums,
  generateReleaseNotes,
  parseSemver,
  resolveReleaseTag,
  validateReleaseTag,
  verifyDefaultBranchAncestry,
} from '../../scripts/release.mjs';

describe('parseSemver', () => {
  it('parses valid stable semantic versions', () => {
    expect(parseSemver('0.1.0')).toEqual({
      major: 0,
      minor: 1,
      patch: 0,
      prerelease: undefined,
      build: undefined,
    });
    expect(parseSemver('1.20.300')).toEqual({
      major: 1,
      minor: 20,
      patch: 300,
      prerelease: undefined,
      build: undefined,
    });
  });

  it('parses valid prerelease and build metadata', () => {
    expect(parseSemver('1.0.0-alpha.1')).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: 'alpha.1',
      build: undefined,
    });
    expect(parseSemver('2.1.0-next.0+sha.12345')).toEqual({
      major: 2,
      minor: 1,
      patch: 0,
      prerelease: 'next.0',
      build: 'sha.12345',
    });
  });

  it('rejects invalid versions', () => {
    expect(parseSemver('v0.1.0')).toBeNull();
    expect(parseSemver('0.1')).toBeNull();
    expect(parseSemver('invalid')).toBeNull();
    expect(parseSemver(null as unknown as string)).toBeNull();
    expect(parseSemver(123 as unknown as string)).toBeNull();
  });
});

describe('validateReleaseTag', () => {
  it('validates matching stable tag and package version', () => {
    const result = validateReleaseTag('v0.1.0', '0.1.0', '0.1.0');
    expect(result).toEqual({
      tag: 'v0.1.0',
      version: '0.1.0',
      isPrerelease: false,
      distTag: 'latest',
    });
  });

  it('identifies prerelease versions and sets distTag to next', () => {
    const result = validateReleaseTag('v0.1.0-next.1', '0.1.0-next.1', '0.1.0-next.1');
    expect(result).toEqual({
      tag: 'v0.1.0-next.1',
      version: '0.1.0-next.1',
      isPrerelease: true,
      distTag: 'next',
    });
  });

  it.each([
    ['0.1.0-beta.1', 'beta'],
    ['0.1.0-beta', 'beta'],
    ['0.1.0-beta.1+build.7', 'beta'],
    ['0.1.0-betamax.1', 'next'],
    ['0.1.0-alpha.beta', 'next'],
    ['0.1.0-BETA.1', 'next'],
  ])('routes prerelease %s to %s', (version, distTag) => {
    expect(validateReleaseTag(`v${version}`, version, version)).toEqual({
      tag: `v${version}`,
      version,
      isPrerelease: true,
      distTag,
    });
  });

  it('rejects tags without a leading v', () => {
    expect(() => validateReleaseTag('0.1.0', '0.1.0')).toThrow(/must start with 'v'/);
  });

  it('rejects invalid tag versions', () => {
    expect(() => validateReleaseTag('v0.1', '0.1.0')).toThrow(/valid semantic version/);
  });

  it('rejects mismatch between tag version and package.json', () => {
    expect(() => validateReleaseTag('v0.2.0', '0.1.0')).toThrow(
      /Tag version "0.2.0" does not match package\.json version "0.1\.0"/
    );
  });

  it('rejects mismatch between package.json and server version', () => {
    expect(() => validateReleaseTag('v0.1.0', '0.1.0', '0.2.0')).toThrow(
      /package\.json version "0.1\.0" does not match MCP server version "0\.2\.0"/
    );
  });
});

describe('resolveReleaseTag', () => {
  const githubBranch = {
    githubActions: 'true',
    githubRefType: 'branch',
    githubRefName: 'main',
  };

  it.each(['main', '123/merge', 'v0.1.0'])(
    'uses the package version for non-tag dry runs on %s',
    (githubRefName) => {
      expect(resolveReleaseTag('0.1.0', {
        ...githubBranch,
        githubRefName,
        isDryRun: true,
      })).toEqual({
        tag: 'v0.1.0',
        version: '0.1.0',
        isPrerelease: false,
        distTag: 'latest',
      });
    }
  );

  it('uses and validates an actual GitHub tag in a dry run', () => {
    const options = { ...githubBranch, githubRefType: 'tag', isDryRun: true };
    expect(resolveReleaseTag('0.1.0-next.1', {
      ...options,
      githubRefName: 'v0.1.0-next.1',
    })).toEqual({
      tag: 'v0.1.0-next.1',
      version: '0.1.0-next.1',
      isPrerelease: true,
      distTag: 'next',
    });
    expect(() => resolveReleaseTag('0.1.0', {
      ...options,
      githubRefName: 'v0.2.0',
    })).toThrow(/does not match package\.json/);
    expect(() => resolveReleaseTag('0.1.0', {
      ...options,
      githubRefName: undefined,
    })).toThrow(/must start with 'v'/);
  });

  it('gives a valid explicit tag precedence over GitHub tag or branch refs', () => {
    for (const githubRefType of ['tag', 'branch']) {
      expect(resolveReleaseTag('0.1.0', {
        ...githubBranch,
        githubRefType,
        githubRefName: 'v0.2.0',
        explicitTag: 'v0.1.0',
      }).tag).toBe('v0.1.0');
    }
  });

  it.each(['invalid', 'v0.2.0', ''])(
    'rejects explicit tag %j instead of falling back to a valid GitHub tag',
    (explicitTag) => {
      expect(() => resolveReleaseTag('0.1.0', {
        ...githubBranch,
        githubRefType: 'tag',
        githubRefName: 'v0.1.0',
        explicitTag,
        isDryRun: true,
      })).toThrow();
    }
  );

  it.each(['main', '123/merge', 'v0.1.0'])(
    'rejects GitHub non-tag publication on %s without an explicit tag',
    (githubRefName) => {
      expect(() => resolveReleaseTag('0.1.0', {
        ...githubBranch,
        githubRefName,
      })).toThrow(/requires a tag ref or an explicit --tag/);
    }
  );

  it('preserves package-version fallback for local publication and non-publishing GitHub modes', () => {
    expect(resolveReleaseTag('0.1.0').tag).toBe('v0.1.0');
    expect(resolveReleaseTag('0.1.0', {
      ...githubBranch,
      isNonPublishing: true,
    }).tag).toBe('v0.1.0');
  });

  it('still validates the server version when using the package-version fallback', () => {
    expect(() => resolveReleaseTag('0.1.0', {
      ...githubBranch,
      isDryRun: true,
      serverVersion: '0.2.0',
    })).toThrow(/does not match MCP server version/);
  });
});

describe('verifyDefaultBranchAncestry', () => {
  it('succeeds when git merge-base indicates ancestor commit', async () => {
    const calls: string[][] = [];
    const mockExec = async (_cmd: string, args: string[]) => {
      calls.push(args);
      return { stdout: '', stderr: '' };
    };

    const res = await verifyDefaultBranchAncestry('HEAD', 'main', mockExec as any);
    expect(res).toEqual({ gitRef: 'HEAD', targetBranch: 'origin/main' });
    expect(calls).toEqual([
      ['rev-parse', '--verify', 'origin/main'],
      ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'],
    ]);
  });

  it('falls back to local branch if origin is not verified', async () => {
    const calls: string[][] = [];
    const mockExec = async (_cmd: string, args: string[]) => {
      calls.push(args);
      if (args[1] === '--verify' && args[2] === 'origin/main') {
        throw new Error('Not found');
      }
      return { stdout: '', stderr: '' };
    };

    const res = await verifyDefaultBranchAncestry('HEAD', 'main', mockExec as any);
    expect(res).toEqual({ gitRef: 'HEAD', targetBranch: 'main' });
  });

  it('throws error when commit is not an ancestor of default branch', async () => {
    const mockExec = async (_cmd: string, args: string[]) => {
      if (args[0] === 'merge-base') {
        throw new Error('exit code 1');
      }
      return { stdout: '', stderr: '' };
    };

    await expect(verifyDefaultBranchAncestry('feature-branch', 'main', mockExec as any)).rejects.toThrow(
      /not an ancestor of default branch/
    );
  });

  it('throws error when no candidate default branch exists', async () => {
    const mockExec = async () => {
      throw new Error('ref not found');
    };

    await expect(verifyDefaultBranchAncestry('HEAD', 'main', mockExec as any)).rejects.toThrow(
      /Could not find default branch ref/
    );
  });
});

describe('computeFileChecksums', () => {
  it('computes sha256, sha1, and file size', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'checksum-test-'));
    try {
      const filePath = path.join(tempDir, 'test.txt');
      await writeFile(filePath, 'hello world\n', 'utf8');

      const checksums = computeFileChecksums(filePath);
      expect(checksums.sizeBytes).toBe(12);
      expect(checksums.sha256).toBe(
        'a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447'
      );
      expect(checksums.shasum).toBe('22596363b3de40b06f981fb85d82312e8c0ed511');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('generateReleaseNotes', () => {
  it('generates release notes for stable release with client configurations and checksums', () => {
    const notes = generateReleaseNotes({
      version: '0.1.0',
      packageName: '@orinnadiak/mcp-rpg-tools',
      tarballFilename: 'orinnadiak-mcp-rpg-tools-0.1.0.tgz',
      sha256: 'abcd1234ef5678',
      isPrerelease: false,
      distTag: 'latest',
    });

    expect(notes).toContain('# Release v0.1.0');
    expect(notes).toContain('"@orinnadiak/mcp-rpg-tools@0.1.0"');
    expect(notes).toContain('cmd');
    expect(notes).toContain('npx --yes @orinnadiak/mcp-rpg-tools@0.1.0');
    expect(notes).toContain('orinnadiak-mcp-rpg-tools-0.1.0.tgz');
    expect(notes).toContain('abcd1234ef5678');
    expect(notes).toContain('private; direct GitHub Release asset downloads require GitHub repository authorization');
    expect(notes).not.toContain('Prerelease Distribution');
  });

  it('includes prerelease warning banner when isPrerelease is true', () => {
    const notes = generateReleaseNotes({
      version: '0.2.0-next.0',
      packageName: '@orinnadiak/mcp-rpg-tools',
      tarballFilename: 'orinnadiak-mcp-rpg-tools-0.2.0-next.0.tgz',
      sha256: '998877665544',
      isPrerelease: true,
      distTag: 'next',
    });

    expect(notes).toContain('# Release v0.2.0-next.0');
    expect(notes).toContain('Prerelease Distribution');
    expect(notes).toContain('under the `next` tag');
    expect(notes).toContain('does not replace the stable `latest` dist-tag');
  });
});

describe('checkNpmPublicationStatus', () => {
  it('returns not_published when npm view returns 404', async () => {
    const mockExec = async () => {
      const err = new Error('npm error code E404\nnpm error 404 Not Found');
      throw err;
    };

    const status = await checkNpmPublicationStatus('@orinnadiak/mcp-rpg-tools', '0.1.0', 'hash123', mockExec as any);
    expect(status).toEqual({ status: 'not_published' });
  });

  it('returns already_published_match when published shasum matches local shasum', async () => {
    const mockExec = async () => {
      return { stdout: '"matching-hash"\n', stderr: '' };
    };

    const status = await checkNpmPublicationStatus(
      '@orinnadiak/mcp-rpg-tools',
      '0.1.0',
      'matching-hash',
      mockExec as any
    );
    expect(status).toEqual({
      status: 'already_published_match',
      publishedShasum: 'matching-hash',
    });
  });

  it('returns already_published_mismatch when published shasum differs from local shasum', async () => {
    const mockExec = async () => {
      return { stdout: '"different-hash"\n', stderr: '' };
    };

    const status = await checkNpmPublicationStatus(
      '@orinnadiak/mcp-rpg-tools',
      '0.1.0',
      'local-hash',
      mockExec as any
    );
    expect(status).toEqual({
      status: 'already_published_mismatch',
      publishedShasum: 'different-hash',
      localShasum: 'local-hash',
    });
  });
});
