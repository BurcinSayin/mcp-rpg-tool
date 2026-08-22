/**
 * Environment parsing and validation.
 *
 * Everything is validated here, at the earliest possible moment, and a bad value
 * exits before any tool is registered and before the transport is connected. That
 * ordering matters: a client that has completed a handshake and then discovers the
 * server is misconfigured has a much worse failure to report than a process that
 * never started.
 *
 * Diagnostics go to stderr only. stdout is the JSON-RPC channel and a single
 * stray write corrupts the protocol stream silently.
 */

import process from 'node:process';

export interface ServerConfig {
  gameSystem: string;
  includeExtended: boolean;
  env: Readonly<Record<string, string | undefined>>;
}

export interface ConfigProblem {
  message: string;
  fatal: boolean;
}

/**
 * Suffix that marks a provider's extended-tier flag.
 *
 * Resolved only against keys the ACTIVE provider declares. A fixed list of every
 * system's flag meant TOY_INCLUDE_EXTENDED silently switched on PF2e's extended
 * tools -- 32 instead of 16 -- and no warning fired, because the ownership check
 * only looks at keys some provider actually claims.
 */
const EXTENDED_KEY_SUFFIX = 'INCLUDE_EXTENDED';

/**
 * Parses and validates. Returns problems rather than exiting, so this stays
 * testable without spawning a process.
 *
 * @param knownSystems provider keys the registry can actually resolve
 * @param configKeysBySystem env keys each provider owns, so a key intended for a
 *        different system is caught instead of being silently ignored. A flag
 *        that is accepted and does nothing is the same dishonesty the tool schema
 *        rules forbid; env vars get the same treatment.
 */
export function parseConfig(
  env: Readonly<Record<string, string | undefined>>,
  knownSystems: readonly string[],
  configKeysBySystem: Readonly<Record<string, readonly string[]>>,
): { config?: ServerConfig; problems: ConfigProblem[] } {
  const problems: ConfigProblem[] = [];

  const raw = env['GAME_SYSTEM'];
  const gameSystem = (raw ?? 'pf2e').trim().toLowerCase();

  if (!knownSystems.includes(gameSystem)) {
    problems.push({
      fatal: true,
      message:
        `Unknown GAME_SYSTEM "${gameSystem}".\n` +
        `Valid values: ${knownSystems.join(', ')}\n` +
        `Set it in your MCP client config, for example: "env": { "GAME_SYSTEM": "${knownSystems[0] ?? 'pf2e'}" }`,
    });
    return { problems };
  }

  // A key belonging to another provider is a real mistake worth surfacing: the
  // user believes they configured something and nothing happens.
  const ownKeys = new Set(configKeysBySystem[gameSystem] ?? []);
  for (const [system, keys] of Object.entries(configKeysBySystem)) {
    if (system === gameSystem) continue;
    for (const key of keys) {
      if (ownKeys.has(key)) continue;
      if (env[key] !== undefined) {
        problems.push({
          fatal: false,
          message:
            `${key} is set but belongs to GAME_SYSTEM="${system}", not "${gameSystem}". It will be ignored.`,
        });
      }
    }
  }

  const extendedKey = [...ownKeys].find((key) => key.endsWith(EXTENDED_KEY_SUFFIX));
  const extendedRaw = extendedKey === undefined ? undefined : env[extendedKey];
  const includeExtended = parseBoolean(extendedRaw);

  if (extendedRaw !== undefined && includeExtended === undefined) {
    problems.push({
      fatal: true,
      message: `${extendedKey ?? EXTENDED_KEY_SUFFIX} is not a boolean. Use true or false.`,
    });
    return { problems };
  }

  // A flag shaped like an extended-tier switch that no active provider owns is
  // almost certainly a mistake -- the user believes they configured something.
  for (const key of Object.keys(env)) {
    if (!key.endsWith(EXTENDED_KEY_SUFFIX) || env[key] === undefined) continue;
    if (ownKeys.has(key)) continue;
    problems.push({
      fatal: false,
      message:
        `${key} is set but GAME_SYSTEM="${gameSystem}" does not use it` +
        `${extendedKey === undefined ? '' : ` (it reads ${extendedKey})`}. It has no effect.`,
    });
  }

  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('INCLUDE_') || value === undefined) continue;
    if (parseBoolean(value) === undefined) {
      problems.push({
        fatal: true,
        message: `${key} is not a boolean. Use true or false.`,
      });
    }
  }
  if (problems.some((p) => p.fatal)) return { problems };

  return {
    config: { gameSystem, includeExtended: includeExtended ?? false, env },
    problems,
  };
}

export function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', ''].includes(normalized)) return false;
  return undefined;
}

/** Writes problems to stderr and exits non-zero if any are fatal. Never touches stdout. */
export function reportAndExitOnFatal(problems: readonly ConfigProblem[]): void {
  for (const problem of problems) {
    process.stderr.write(`${problem.fatal ? 'error' : 'warning'}: ${problem.message}\n`);
  }
  if (problems.some((p) => p.fatal)) {
    process.exit(1);
  }
}
