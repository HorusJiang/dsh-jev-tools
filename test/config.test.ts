/**
 * Settings schema tests.
 *
 * The defaults asserted here are the S0 measurements (see
 * `docs/s0-trigger-rate.md`). If one of these fails, either the measurement was
 * superseded or a threshold drifted — both worth noticing.
 *
 * @module dsh-jev-tools/test/config
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  Config,
  DEFAULT_API_KEY_ENV,
  DEFAULT_BASE_URL,
  DEFAULT_TOOL_ALLOWLIST,
  JEV_TOOLS_NS,
  resolveSettings,
} from '../lib/config.js'

test('namespace is a lowercase-hyphenated identifier', () => {
  // The settings seam rejects anything else with a TypeError.
  assert.match(JEV_TOOLS_NS, /^[a-z][a-z0-9-]*$/)
})

test('defaults match the S0 measurements', () => {
  const s = resolveSettings(undefined)
  assert.equal(s.enabled, true)
  assert.equal(s.apiKeyEnv, DEFAULT_API_KEY_ENV)
  // Same variable the official TypeSafe SDK reads: existing Jev users need no setup.
  assert.equal(s.apiKeyEnv, 'TYPESAFE_API_KEY')
  // A bare host: the backend appends the vendor's own path to it.
  assert.equal(s.baseUrl, DEFAULT_BASE_URL)
  assert.equal(s.baseUrl, 'https://api.typesafe.ai')
  assert.equal(s.model, 'jev-latest')
  assert.equal(s.sessionCallLimit, 200)

  // Measured: 2000 keeps 31.9% of the achievable saving while avoiding the
  // marginal band where a judgment costs 300ms to save ~1000 tokens.
  assert.equal(s.prune.minTokens, 2000)
  // Measured: uncapped worst turn was 27 triggers (about 8.1s); 3 caps it at 0.9s.
  assert.equal(s.prune.perTurnLimit, 3)
  assert.equal(s.prune.headLines, 40)
  assert.equal(s.prune.tailLines, 40)
  assert.equal(s.prune.keepHigh, 0.5)
  assert.equal(s.prune.minKeepRatio, 0.2)
  assert.equal(s.prune.minSaving, 0.15)

  // Measured: the typical catalog held 29 skills, so this fires for real users.
  assert.equal(s.suggest.minCatalogSize, 15)
  assert.equal(s.suggest.minConfidence, 0.3)
})

test('the pruning allowlist excludes pwsh on purpose', () => {
  const s = resolveSettings(undefined)
  assert.deepEqual([...s.prune.toolAllowlist].sort(), [...DEFAULT_TOOL_ALLOWLIST].sort())
  // Terminal output carries build logs, error traces and file listings whose
  // "irrelevant" parts are often exactly what a debugging step needs.
  assert.equal(s.prune.toolAllowlist.includes('pwsh'), false)
  assert.equal(s.prune.toolAllowlist.includes('bash'), false)
})

test('a composition entry overrides defaults without dropping the others', () => {
  const s = resolveSettings({ enabled: false, prune: { minTokens: 5000 } })
  assert.equal(s.enabled, false)
  assert.equal(s.prune.minTokens, 5000)
  // Nested defaults survive a partial nested override.
  assert.equal(s.prune.perTurnLimit, 3)
  assert.equal(s.suggest.minCatalogSize, 15)
})

test('the schema is usable as a configuration-surface declaration', () => {
  // A settings card renders from this schema, so it must be callable and
  // resolve an empty entry to a complete value.
  assert.equal(typeof Config, 'function')
  const resolved = Config({}) as { prune: { enabled: boolean } }
  assert.equal(resolved.prune.enabled, true)
})

test('a key scoped to another System One host can point the plugin at it', () => {
  // The setting exists because a key is issued *for* a host: sent to the default
  // one it earns a 401, and a fail-open plugin would hide that. Overriding the
  // endpoint must also leave every sibling field alone.
  const s = resolveSettings({ baseUrl: 'https://api.codiv.ai' })
  assert.equal(s.baseUrl, 'https://api.codiv.ai')
  assert.equal(s.apiKeyEnv, DEFAULT_API_KEY_ENV)
  assert.equal(s.model, 'jev-latest')
})
