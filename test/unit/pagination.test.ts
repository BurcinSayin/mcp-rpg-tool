import { describe, expect, it } from 'vitest';
import { SearchCursorStore } from '../../src/pagination.js';
import { CURSOR_CACHE_BYTES, CURSOR_CACHE_ENTRIES, CURSOR_TTL_MS } from '../../src/constants.js';

describe('search cursor transitions', () => {
  it('allows replay and preserves the original expiry across descendants', () => {
    let now = 0;
    const store = new SearchCursorStore<number>({ now: () => now });
    const first = store.issue('context', 3);
    expect(() => store.read(first, 'other')).toThrow(/does not match/);
    expect(store.read(first, 'context').position).toBe(3);
    now = CURSOR_TTL_MS - 1;
    const state = store.read(first, 'context');
    const next = store.issue('context', 6, state.expiresAt);
    expect(store.read(first, 'context').position).toBe(3);
    expect(store.read(next, 'context').position).toBe(6);
    now++;
    expect(() => store.read(first, 'context')).toThrow(/Invalid or expired/);
    expect(() => store.read(next, 'context')).toThrow(/Invalid or expired/);
    expect(() => store.issue('context', 9, state.expiresAt)).toThrow(/Invalid or expired/);
  });

  it('rejects unknown, tampered and foreign-instance tokens', () => {
    const store = new SearchCursorStore<number>();
    const token = store.issue('context', 1);
    for (const invalid of ['', `${token}x`, '00000000-0000-4000-8000-000000000000']) {
      expect(() => store.read(invalid, 'context')).toThrow(/Invalid or expired/);
    }
    expect(() => new SearchCursorStore<number>().read(token, 'context')).toThrow(/Invalid or expired/);
  });

  it('evicts old handles at the entry ceiling', () => {
    const store = new SearchCursorStore<number>();
    const first = store.issue('context', 0);
    let last = first;
    for (let i = 0; i < CURSOR_CACHE_ENTRIES; i++) last = store.issue('context', i);
    expect(() => store.read(first, 'context')).toThrow(/Invalid or expired/);
    expect(store.read(last, 'context').position).toBe(CURSOR_CACHE_ENTRIES - 1);
  });

  it('never returns an unstored handle when the byte ceiling is exceeded', () => {
    expect(() => new SearchCursorStore<string>().issue('context', 'x'.repeat(CURSOR_CACHE_BYTES))).toThrow(/Invalid or expired/);
  });
});
