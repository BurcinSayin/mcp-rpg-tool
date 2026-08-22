/**
 * Makes "the suite runs offline" a property the machine enforces, not a habit.
 *
 * Node's fetch is undici-backed, so installing a MockAgent with net connect
 * disabled means any request that is not explicitly stubbed throws instead of
 * quietly reaching the internet. Without this, a test could pass in CI purely
 * because a live service happened to be up — which is exactly the false confidence
 * a fixture-based suite is supposed to eliminate.
 */

import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { afterAll, afterEach, beforeAll } from 'vitest';

let agent: MockAgent;
let original: Dispatcher;

beforeAll(() => {
  original = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});

afterEach(() => {
  // Surfaces stubs that were declared but never called, which usually means the
  // code under test took a different path than the test assumed.
  try {
    agent.assertNoPendingInterceptors();
  } catch (error) {
    agent.pendingInterceptors().forEach((i) => {
      console.warn(`unused interceptor: ${i.method} ${i.origin}${i.path}`);
    });
    throw error;
  }
});

afterAll(async () => {
  await agent.close();
  setGlobalDispatcher(original);
});

/** Handle for tests that need to register interceptors. */
export function mockAgent(): MockAgent {
  return agent;
}
