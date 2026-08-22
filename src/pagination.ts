import { randomUUID } from 'node:crypto';
import { BoundedCache } from './cache.js';
import { CURSOR_CACHE_BYTES, CURSOR_CACHE_ENTRIES, CURSOR_TTL_MS, MAX_CURSOR_CHARS } from './constants.js';
import { BackendError } from './provider/types.js';

export interface CursorState<T> {
  context: string;
  position: T;
  expiresAt: number;
}

function invalidCursor(): BackendError {
  return new BackendError('Invalid or expired cursor; restart the search without cursor.', undefined, 'invalid-cursor');
}

export class SearchCursorStore<T> {
  readonly #now: () => number;
  readonly #cache = new BoundedCache<CursorState<T>>({
    maxEntries: CURSOR_CACHE_ENTRIES,
    maxBytes: CURSOR_CACHE_BYTES,
  });

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  issue(context: string, position: T, expiresAt = this.#now() + CURSOR_TTL_MS): string {
    if (!Number.isFinite(expiresAt) || expiresAt <= this.#now()) throw invalidCursor();
    const cursor = randomUUID();
    this.#cache.set(cursor, { context, position, expiresAt });
    if (!this.#cache.has(cursor)) throw invalidCursor();
    return cursor;
  }

  read(cursor: string, context: string): CursorState<T> {
    if (typeof cursor !== 'string' || cursor.length !== MAX_CURSOR_CHARS ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(cursor)) {
      throw invalidCursor();
    }
    const state = this.#cache.get(cursor);
    if (state === undefined || state.expiresAt <= this.#now()) throw invalidCursor();
    if (state.context !== context) {
      throw new BackendError('Cursor does not match this search; restart the search without cursor.', undefined, 'cursor-context-mismatch');
    }
    return state;
  }
}
