/**
 * A minimal JSON-RPC client that talks to the built server over stdio.
 *
 * Deliberately raw rather than using the SDK client: these tests are about the
 * wire behaviour a real client sees — including that stdout carries protocol and
 * nothing else — and a raw reader is what can actually observe that.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const entryPoint = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

export interface ServerHandle {
  readonly initialization: unknown;
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  stderrText(): string;
  close(): Promise<number | null>;
}

export interface LaunchResult {
  handle?: ServerHandle;
  exitCode: number | null;
  stderr: string;
  stdout: string;
}

export interface ServerLaunchOptions {
  command?: string;
  args?: readonly string[];
  cwd?: string;
}

function launchEnvironment(overrides: Record<string, string>): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const key of [
    'PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP',
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  ]) {
    const value = process.env[key];
    if (value !== undefined) inherited[key] = value;
  }
  return { ...inherited, ...overrides };
}

/** Starts the server and completes the MCP handshake. */
export async function startServer(
  env: Record<string, string> = {},
  launch: ServerLaunchOptions = {},
): Promise<ServerHandle> {
  const child = spawn(launch.command ?? process.execPath, [...(launch.args ?? [entryPoint])], {
    // Inherit OS launch necessities, never arbitrary game configuration.
    env: launchEnvironment(env),
    cwd: launch.cwd ?? path.dirname(entryPoint),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const handle = attach(child);
  try {
    const initialization = await handle.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'integration-test', version: '0.0.0' },
    });
    handle.notify('notifications/initialized');
    return { ...handle, initialization };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * Starts the server expecting it to exit rather than serve. Used for the
 * configuration-failure path, where the whole point is that no handshake happens.
 */
export function launchExpectingExit(env: Record<string, string> = {}): Promise<LaunchResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entryPoint], {
      env: launchEnvironment(env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));

    child.on('close', (code) => resolve({ exitCode: code, stderr, stdout }));
  });
}

function attach(child: ChildProcessWithoutNullStreams): Omit<ServerHandle, 'initialization'> {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  let stderr = '';
  let buffer = '';
  let failure: Error | undefined;
  let closed = false;
  let closeCode: number | null = null;
  const completion = new Promise<number | null>((resolve) => {
    child.once('close', (code) => {
      closed = true;
      closeCode = code;
      fail(new Error(`Server exited (${code}). stderr: ${stderr}`));
      resolve(code);
    });
  });
  function fail(error: Error): void {
    failure = error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  }
  child.once('error', fail);
  child.stdin.on('error', fail);

  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));

  child.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    buffer += text;

    // Newline-delimited JSON.
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line !== '') dispatch(line);
      index = buffer.indexOf('\n');
    }
  });

  function dispatch(line: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string; code?: number } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      // A non-JSON line on stdout means the protocol stream was corrupted, which
      // is exactly the failure the stdout tests look for. Surface it loudly.
      for (const waiter of pending.values()) {
        waiter.reject(new Error(`Non-JSON output on stdout: ${line.slice(0, 200)}`));
      }
      pending.clear();
      return;
    }

    if (message.id === undefined) return; // notification from server
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);

    if (message.error) {
      waiter.reject(
        Object.assign(new Error(message.error.message ?? 'rpc error'), {
          code: message.error.code,
        }),
      );
    } else {
      waiter.resolve(message.result);
    }
  }

  return {
    request(method, params) {
      if (failure !== undefined) return Promise.reject(failure);
      const id = nextId++;
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} });
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for "${method}". stderr: ${stderr.slice(-400)}`));
        }, 15_000);

        pending.set(id, {
          resolve: (value: unknown) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error: Error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        child.stdin.write(`${payload}\n`);
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} })}\n`);
    },
    stderrText: () => stderr,
    close() {
      if (closed) return Promise.resolve(closeCode);
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 2_000);
      timer.unref();
      return completion.finally(() => clearTimeout(timer));
    },
  };
}
