/**
 * Judgment memoisation.
 *
 * The same tool result is frequently seen more than once — a file re-read
 * after an edit, a page fetched twice — and re-judging it wastes both the
 * latency budget and, more importantly, sends the same content to a third
 * party again. The key includes the task text because relevance is relative to
 * it: the same passage can be relevant to one request and noise to the next.
 *
 * @module dsh-jev-tools/memo
 */

import { createHash } from 'node:crypto'

/** A bounded key→value store. */
export interface Memo<T> {
  get (key: string): T | undefined
  set (key: string, value: T): void
  readonly size: number
}

/**
 * Hash the parts that identify a judgment.
 *
 * @param parts - the discriminating values; `undefined` entries are skipped.
 * @returns a short hex digest.
 */
export function fingerprint (parts: readonly (string | number | undefined)[]): string {
  const hash = createHash('sha256')
  for (const part of parts) {
    if (part === undefined) continue
    hash.update(String(part))
    hash.update('\u0000')
  }
  return hash.digest('hex').slice(0, 32)
}

/**
 * Create a least-recently-used memo.
 *
 * @param maxEntries - ceiling on retained entries; the oldest is evicted.
 * @returns the memo.
 */
export function createMemo<T> (maxEntries = 256): Memo<T> {
  const entries = new Map<string, T>()
  return {
    get (key) {
      const value = entries.get(key)
      if (value === undefined) return undefined
      // Re-insert so eviction order stays least-recently-used.
      entries.delete(key)
      entries.set(key, value)
      return value
    },
    set (key, value) {
      entries.delete(key)
      entries.set(key, value)
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next()
        if (oldest.done === true) break
        entries.delete(oldest.value)
      }
    },
    get size () {
      return entries.size
    },
  }
}
