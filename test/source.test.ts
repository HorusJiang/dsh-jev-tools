/**
 * The producer identity every injected message carries, enforced.
 *
 * Session format v4 has no shared catch-all source kind. A message states *who*
 * produced it, and the retired `{ kind: 'plugin', plugin }` wrapper is refused
 * by the writer — which does not drop that one message, it fails the whole turn
 * with "format v4 message requires a producer-owned source kind". That is
 * exactly how this plugin broke: on 2026-09-24 a pruning judgment created its
 * notice, the notice could not be written, and the session ended mid-step with
 * no `turn/end`. Nothing in the ledger, the plugin's own tests, or the plugin's
 * output said so; only the session's error line did.
 *
 * The kind is therefore asserted in one place, and the scan below fails if the
 * wrapper is written anywhere under `src/` again. A feature test can only cover
 * the notices it knows how to reach; the file scan covers the ones it does not.
 *
 * @module dsh-jev-tools/test/source
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { PLUGIN_ID, PLUGIN_SOURCE_KIND, noticeSource } from '../lib/source.js'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

/** Every TypeScript file under `src/`, as a path relative to `src/`. */
function sourceFiles (): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (entry.isFile() && entry.name.endsWith('.ts')) found.push(path.relative(SRC, full))
    }
  }
  walk(SRC)
  return found.sort()
}

/**
 * The code lines of one file that state the retired source wrapper.
 *
 * Prose is skipped rather than forbidden: the modules that explain why the
 * wrapper is gone have to name it, and a comment is not a message.
 * @param text - the file's source text.
 * @returns the offending lines, trimmed.
 */
function retiredWrapperLines (text: string): string[] {
  return text.split('\n')
    .map(line => line.trim())
    .filter(line => {
      if (line.startsWith('*') || line.startsWith('//') || line.startsWith('/*')) return false
      return /kind:\s*['"]plugin['"]/.test(line)
    })
}

test('the source kind names this plugin, and never the retired wrapper', () => {
  assert.equal(PLUGIN_ID, 'dsh-jev-tools')
  // The harness's v3->v4 migration records an unknown third-party producer as
  // `plugin:<name>`; using the same value keeps a session's historical notices
  // and the ones written today under one identity.
  assert.equal(PLUGIN_SOURCE_KIND, 'plugin:dsh-jev-tools')
})

test('a notice carries its kind, the notice form, and its one-line summary', () => {
  assert.deepEqual(noticeSource('read: 5000 → 3000 tokens'), {
    kind: 'plugin:dsh-jev-tools',
    form: 'notice',
    summary: 'read: 5000 → 3000 tokens',
  })
})

test('no module writes the retired plugin source wrapper', () => {
  const offenders: string[] = []
  for (const name of sourceFiles()) {
    const text = fs.readFileSync(path.join(SRC, name), 'utf8')
    for (const line of retiredWrapperLines(text)) offenders.push(`${name}: ${line}`)
  }
  assert.deepEqual(offenders, [], 'these lines write the retired v3 wrapper the v4 writer refuses')
})
