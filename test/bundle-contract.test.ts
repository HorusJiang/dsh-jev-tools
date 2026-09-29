/**
 * The mount row and the settings namespace, kept identical.
 *
 * Two surfaces address this bundle's configuration, and they use **different
 * names** for the same thing. DSH's settings page keys a namespace by the mount
 * row id (`SettingsForms.describe()` publishes `entry.options.id`, and a write
 * resolves the same way), while this bundle's own card — the occupant of
 * `plugins.bundle.config` — and the plugin page's config seat are keyed by the
 * **package name**.
 *
 * Mounted as `jev-tools` the two disagreed for eleven releases: the card read no
 * namespace, so every toggle stayed disabled and both endpoint fields stayed
 * blank, with no error printed anywhere. Nothing in the suite could see it,
 * because every client test fed the card the namespace it was looking for.
 *
 * So the identity is asserted here, on the three files that have to agree:
 * `package.json` (the name), `cordis.patch.yml` (the row), and
 * `client/client.js` (the namespace the card asks for).
 *
 * @module dsh-jev-tools/test/bundle-contract
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { Config } from '../lib/config.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Every field this bundle's card reads or writes, by schema path.
 *
 * The three toggles, the two endpoint fields, and the key reference the input
 * names — exactly the set the card draws.
 */
const CARD_FIELDS = ['enabled', 'apiKeyEnv', 'baseUrl', 'model', 'prune.enabled', 'suggest.enabled']

/**
 * Whether one schema path is marked volatile.
 *
 * Read straight off the schema node's `meta`, which is the exact fact
 * `SettingsForms` reads in `volatileForm()` — the schema publishes a bundle's
 * settings page from the fields that carry the marker.
 *
 * @param fieldPath - dotted field path inside the Config schema.
 * @returns whether the field is published as editable.
 */
function isVolatileField (fieldPath: string): boolean {
  let node: any = Config
  for (const key of fieldPath.split('.')) node = node?.dict?.[key]
  return node?.meta?.volatile === true
}

/** The package manifest, as the identity source of truth. */
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  name: string
  files?: string[]
  dsh?: { bundle?: { patch?: string } }
}

/**
 * The `insert:` rows of a bundle patch.
 *
 * Deliberately a narrow reader rather than a YAML parser: the patch is a literal
 * two-field list, the suite carries no YAML dependency, and a shape this checker
 * cannot read should fail loudly here rather than pass silently. A row is counted
 * only when an `id:` line and the `name:` line that follows it are the whole
 * contract this test is about.
 *
 * @param text - the patch file's contents.
 * @returns one entry per `- id:` / `name:` pair, in file order.
 */
function insertedRows (text: string): Array<{ id: string, name: string }> {
  return [...text.matchAll(/^\s*-\s+id:\s*(\S+)\s*\r?\n\s+name:\s*(\S+)\s*$/gm)]
    .map(match => ({ id: match[1]!, name: match[2]! }))
}

test('the mounted row id is the package name, and it mounts the package', () => {
  const patchPath = path.join(ROOT, 'cordis.patch.yml')
  const rows = insertedRows(fs.readFileSync(patchPath, 'utf8'))
  assert.equal(rows.length, 1, `expected exactly one inserted row in cordis.patch.yml, found ${rows.length}`)
  const [row] = rows
  assert.equal(row!.name, MANIFEST.name, 'the row must mount this package')
  // The row id is the namespace DSH publishes for this bundle's settings page.
  assert.equal(row!.id, MANIFEST.name, 'the row id must equal the package name, or the card reads no namespace')
})

test('the card asks for that same namespace', () => {
  const card = fs.readFileSync(path.join(ROOT, 'client', 'client.js'), 'utf8')
  const declared = /const NS = '([^']+)'/.exec(card)
  assert.ok(declared !== null, 'client.js no longer declares its settings namespace')
  assert.equal(declared[1], MANIFEST.name)
})

test('the bundle patch this check reads is the one the package declares', () => {
  assert.equal(MANIFEST.dsh?.bundle?.patch, './cordis.patch.yml')
  // The npm package page shows `files`; a patch outside it would not ship, and
  // the row would then never mount at all.
  assert.ok(
    (MANIFEST.files ?? []).includes('cordis.patch.yml'),
    'cordis.patch.yml must be published for the bundle row to exist'
  )
})

test('every field the card draws is volatile', () => {
  // DSH derives a bundle's settings page through `volatileForm()`: a schema with
  // **no** volatile field yields no form at all, so `describe()` never publishes
  // the namespace — and the card, finding nothing, draws three disabled toggles
  // and two read-only endpoint fields with no error anywhere. This is the second
  // half of that failure; the row id had to be the package name as well.
  const missing = CARD_FIELDS.filter(fieldPath => !isVolatileField(fieldPath))
  assert.deepEqual(
    missing,
    [],
    'a field the card draws is not volatile, so the settings page publishes nothing for this bundle'
  )
})
