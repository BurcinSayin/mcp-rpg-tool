import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { startServer } from '../integration/stdio-client.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));

it('installs a production-only tarball and serves MCP through its entry and npm bin', async () => {
  const npmCli = process.env['npm_execpath'];
  if (!npmCli) throw new Error('Run this suite through npm run test:package (npm_execpath is required)');
  const temporary = await mkdtemp(path.join(tmpdir(), 'mcp artifact '));
  let diagnostics = '';
  try {
    const relative = path.relative(await realpath(root), await realpath(temporary));
    if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) {
      throw new Error('Artifact consumer must be outside the checkout');
    }
    const cache = path.join(temporary, 'npm-cache');
    const userconfig = path.join(temporary, '.npmrc');
    await writeFile(userconfig, '');
    const cleanEnv: Record<string, string | undefined> = { ...process.env, npm_config_cache: cache };
    for (const key of Object.keys(cleanEnv)) {
      if (key.toLowerCase().includes('script') || key.toLowerCase().includes('allow')
        || key.toLowerCase() === 'npm_config_userconfig') {
        delete cleanEnv[key];
      }
    }
    cleanEnv['npm_config_userconfig'] = userconfig;
    cleanEnv['npm_config_ignore_scripts'] = 'false';
    const npm = async (args: string[], cwd: string) => {
      try {
        const result = await exec(process.execPath, [npmCli, ...args], {
          cwd, env: cleanEnv,
          timeout: 120000, maxBuffer: 8 * 1024 * 1024,
        });
        diagnostics += `\n${args.join(' ')}\n${result.stdout}\n${result.stderr}`;
        return result.stdout;
      } catch (error) {
        diagnostics += `\n${args.join(' ')}\n${String(error)}`;
        throw error;
      }
    };
    const packed = JSON.parse(await npm([
      '--silent', 'pack', '--json', '--pack-destination', temporary,
    ], root)) as { filename: string; files: { path: string; mode?: number }[] }[];
    expect(packed).toHaveLength(1);
    const artifact = packed[0]!;
    const files = artifact.files.map((file) => file.path);
    expect(files).toEqual(expect.arrayContaining([
      'package.json', 'README.md', 'docs/providers/pf2e.md', 'LICENSE', 'dist/index.js',
    ]));
    for (const file of files) {
      expect(file, 'Unexpected packed member').toMatch(/^(?:package\.json|README\.md|docs\/providers\/pf2e\.md|LICENSE|dist\/(?:[^/]+\/)*[^/]+\.(?:js|js\.map|d\.ts))$/);
    }
    const entry = artifact.files.find((file) => file.path === 'dist/index.js')!;
    if (process.platform !== 'win32' && entry.mode !== undefined) {
      expect(entry.mode & 0o111).not.toBe(0);
    }
    const consumer = path.join(temporary, 'consumer');
    await mkdir(consumer);
    await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ name: 'artifact-consumer', private: true }));
    await writeFile(path.join(consumer, '.npmrc'), '');
    await npm(['install', '--omit=dev', '--no-audit', '--no-fund', path.join(temporary, artifact.filename)], consumer);
    const installed = path.join(consumer, 'node_modules', '@orinnadiak', 'mcp-rpg-tools');
    const metadata = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8')) as {
      version: string; bin: Record<string, string>;
    };
    expect(metadata).toMatchObject({
      name: '@orinnadiak/mcp-rpg-tools', version: '0.1.0', license: 'MIT', type: 'module',
      bin: { 'mcp-rpg-tools': './dist/index.js' },
    });
    const tree = JSON.parse(await npm(['ls', '--all', '--omit=dev', '--json'], consumer)) as {
      dependencies?: Record<string, unknown>;
    };
    function checkDependencies(node: { dependencies?: Record<string, unknown> }): void {
      for (const [name, dependency] of Object.entries(node.dependencies ?? {})) {
        expect(['typescript', 'vitest', '@modelcontextprotocol/inspector']).not.toContain(name);
        checkDependencies(dependency as typeof node);
      }
    }
    checkDependencies(tree);
    for (const args of [
      [path.resolve(installed, metadata.bin['mcp-rpg-tools']!)],
      [npmCli, 'exec', '--offline', '--', 'mcp-rpg-tools'],
    ]) {
      const server = await startServer({ GAME_SYSTEM: 'toy', npm_config_cache: cache }, {
        command: process.execPath, args, cwd: consumer,
      });
      try {
        expect(server.initialization).toMatchObject({
          serverInfo: { name: 'rpg-lookup', version: metadata.version },
        });
        const listing = await server.request('tools/list') as { tools: { name: string }[] };
        expect(listing.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
          'toy_search_widget', 'toy_get_widget_details',
        ]));
        const result = await server.request('tools/call', {
          name: 'toy_get_widget_details', arguments: { id: 'widget-1' },
        }) as { isError?: boolean; structuredContent: unknown };
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          id: 'widget-1', body: 'A small brass widget. Turns clockwise.',
        });
      } finally {
        await server.close();
      }
    }
  } catch (error) {
    throw new Error(`Artifact verification failed. npm diagnostics:${diagnostics}`, { cause: error });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
