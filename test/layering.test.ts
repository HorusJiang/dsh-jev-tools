/**
 * Architectural layering, enforced.
 *
 * The twenty-odd modules in `src/` are arranged in layers, and until this file
 * existed nothing checked that. An upward import — a state module reaching into
 * a feature, a foundation module reaching into anything — is the kind of change
 * that looks harmless in a diff and quietly turns a readable plugin into a knot.
 *
 * The map is declared explicitly rather than derived, because a derived map
 * would agree with whatever the code currently does, which is the opposite of
 * enforcement. What is asserted is the invariant that matters:
 *
 *   **every dependency points strictly downward, and there are no cycles.**
 *
 * A module must also be *listed*, so adding a file forces a decision about where
 * it belongs instead of letting it default to wherever it landed.
 *
 * The file is read as text rather than imported: `src/*.ts` uses `.js` import
 * specifiers for the compiled output, which Node cannot resolve against the
 * sources (see `docs/dev-workflow.md` §7).
 *
 * @module dsh-jev-tools/test/layering
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

/**
 * Which layer each module belongs to. Lower is more foundational.
 *
 * A module may only import from a strictly lower layer.
 */
const LAYERS: Record<string, number> = {
  // 0 — foundation: no internal dependencies at all.
  'backends/types': 0,
  budget: 0,
  calibrate: 0,
  config: 0,
  'context-cache': 0,
  host: 0,
  http: 0,
  i18n: 0,
  memo: 0,
  tokens: 0,

  // 1 — phrasing, credentials, request building, settings wiring, screening
  // vocabulary. These depend on foundation modules only.
  credentials: 1,
  degrade: 1,
  notify: 1,
  request: 1,
  'settings-ns': 1,
  'features/screen': 1,

  // 2 — the vendor binding, and the ledger's neutral surface.
  'backends/jev': 2,
  ledger: 2,

  // 3 — durable ledger, capabilities, diagnostics, and the model-facing tool.
  'features/prune': 3,
  'features/skill-suggest': 3,
  'ledger-domain': 3,
  status: 3,
  'tools/jev-ask': 3,
  'tools/jev-gate': 3,

  // 4 — the composition root, which may see everything.
  index: 4,
}

/** Every module name under `src/`, as `dir/file` without the extension. */
function modules (): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.name.endsWith('.ts')) continue
      found.push(path.relative(SRC, full).replaceAll('\\', '/').replace(/\.ts$/, ''))
    }
  }
  walk(SRC)
  return found.sort()
}

/** The internal modules one source file imports, resolved to module names. */
function dependenciesOf (name: string): string[] {
  const text = fs.readFileSync(path.join(SRC, `${name}.ts`), 'utf8')
  const resolved = new Set<string>()
  for (const match of text.matchAll(/from\s+'(\.[^']+)'/g)) {
    const specifier = match[1]!
    const target = path.posix
      .normalize(path.posix.join(path.posix.dirname(name), specifier))
      .replace(/\.js$/, '')
    resolved.add(target)
  }
  return [...resolved].sort()
}

test('every source module is assigned a layer', () => {
  // Adding a file must force a decision about where it belongs, rather than
  // letting it default to wherever it happened to be written.
  const unlisted = modules().filter(name => LAYERS[name] === undefined)
  assert.deepEqual(unlisted, [], 'these modules are missing from the layer map')
})

test('the layer map contains no stale entries', () => {
  // A map that outlives the files it describes stops being a map.
  const stale = Object.keys(LAYERS).filter(name => !fs.existsSync(path.join(SRC, `${name}.ts`)))
  assert.deepEqual(stale, [], 'these layer entries name modules that do not exist')
})

test('every dependency points strictly downward', () => {
  const violations: string[] = []
  for (const name of modules()) {
    const from = LAYERS[name]
    if (from === undefined) continue
    for (const dependency of dependenciesOf(name)) {
      const to = LAYERS[dependency]
      if (to === undefined) {
        violations.push(`${name} -> ${dependency} (the target is not in the layer map)`)
        continue
      }
      if (to >= from) {
        violations.push(`${name} (layer ${from}) -> ${dependency} (layer ${to})`)
      }
    }
  }
  assert.deepEqual(violations, [], 'these imports point sideways or upward')
})

test('the dependency graph is acyclic', () => {
  // Downward-only edges already imply acyclicity, but this is the property that
  // actually breaks a module loader — and it fails with a much clearer message
  // here than as a circular-import surprise at runtime.
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []

  const visit = (name: string): void => {
    const seen = state.get(name)
    if (seen === 'done') return
    if (seen === 'visiting') {
      const cycle = [...stack.slice(stack.indexOf(name)), name].join(' -> ')
      assert.fail(`import cycle: ${cycle}`)
    }
    state.set(name, 'visiting')
    stack.push(name)
    for (const dependency of dependenciesOf(name)) {
      if (fs.existsSync(path.join(SRC, `${dependency}.ts`))) visit(dependency)
    }
    stack.pop()
    state.set(name, 'done')
  }

  for (const name of modules()) visit(name)
})

test('the foundation layer really is foundational', () => {
  // If these ever import each other, every layer above inherits the knot.
  for (const name of Object.keys(LAYERS).filter(key => LAYERS[key] === 0)) {
    assert.deepEqual(dependenciesOf(name), [], `${name} must have no internal dependencies`)
  }
})
