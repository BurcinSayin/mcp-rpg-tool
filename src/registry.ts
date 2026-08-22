/**
 * Maps a GAME_SYSTEM value to a provider factory.
 *
 * The only module outside src/provider/ permitted to import a concrete provider;
 * lint enforces that. Everything else depends on the neutral contract, which is
 * what keeps the abstraction real rather than aspirational.
 */

import type { ProviderFactory, SystemProvider } from './provider/types.js';
import { createPf2eProvider, PF2E_CONFIG_KEYS } from './provider/pf2e/index.js';
import { createToyProvider, TOY_CONFIG_KEYS } from './provider/toy/index.js';

const FACTORIES: Readonly<Record<string, ProviderFactory>> = {
  pf2e: createPf2eProvider,
  toy: createToyProvider,
};

const CONFIG_KEYS_BY_SYSTEM: Readonly<Record<string, readonly string[]>> = {
  pf2e: PF2E_CONFIG_KEYS,
  toy: TOY_CONFIG_KEYS,
};

export function knownSystems(): string[] {
  return Object.keys(FACTORIES).sort();
}

/**
 * Config keys each provider owns.
 */
export function configKeysBySystem(): Record<string, readonly string[]> {
  return { ...CONFIG_KEYS_BY_SYSTEM };
}

export function createProvider(
  systemKey: string,
  env: Readonly<Record<string, string | undefined>>,
): SystemProvider {
  const factory = FACTORIES[systemKey];
  if (factory === undefined) {
    throw new Error(
      `No provider registered for "${systemKey}". Known: ${knownSystems().join(', ')}`,
    );
  }
  return factory(env);
}
