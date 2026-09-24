/**
 * Status-report tests.
 *
 * `/jev-status` is the plugin's only diagnostic surface, so it carries the
 * claims a user has to be able to check: whether the ledger is persisted,
 * whether writes have been failing, and whether the cumulative numbers mean
 * what they say. Those are exactly the lines that must not silently regress.
 *
 * @module dsh-jev-tools/test/status
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveSettings } from '../lib/config.js'
import { createBudget } from '../lib/budget.js'
import { createContextCache } from '../lib/context-cache.js'
import { buildStatus, type StatusDeps } from '../lib/status.js'
import { createMemoryLedger, EMPTY_TOTALS, type JudgmentRecord, type Ledger, type LedgerSummary } from '../lib/ledger.js'

/** A minimal judgment record. */
function makeRecord (overrides: Partial<JudgmentRecord> = {}): JudgmentRecord {
  return {
    ts: 1_700_000_000_000,
    agentId: 'agent-1',
    feature: 'prune',
    backendId: 'jev',
    model: 'jev-1.13.0',
    latencyMs: 120,
    outcome: 'judged',
    ...overrides,
  }
}

/** A ledger whose every answer is supplied by the test. */
function stubLedger (summary: Partial<LedgerSummary>, store: Ledger['store'], entries: Ledger['entries'] = () => []): Ledger {
  return {
    record () {},
    entries,
    get size () { return summary.retained ?? 0 },
    summary () { return { ...EMPTY_TOTALS, retained: 0, models: {}, ...summary } },
    store,
  }
}

/** Deps with everything the report reads, overridable per test. */
function deps (overrides: Partial<StatusDeps> = {}): StatusDeps {
  return {
    settings: () => resolveSettings(undefined),
    credentials: () => undefined,
    cache: createContextCache(),
    budget: createBudget(3, 200),
    ledger: createMemoryLedger(),
    ...overrides,
  }
}

test('a persisted ledger says so, and reports the cumulative count', async () => {
  const report = await buildStatus(deps({
    ledger: stubLedger(
      {
        records: 57, judged: 40, skipped: 17, savedTokens: 21_000,
        baselineSavedTokens: 8_000, netTokens: 13_000,
        baselineMeasured: 9, baselineUnmeasured: 4, retained: 57,
      },
      { kind: 'domain', failures: 0 }
    ),
  }), 'agent-1')

  assert.match(report, /Ledger store: persistent/)
  assert.match(report, /57 records cumulative/)
  assert.match(report, /Total removed: 21000 tokens/)
  assert.match(report, /built-in deterministic pruner would have removed: 8000 tokens/)
  assert.match(report, /net gain from this plugin: 13000 tokens/)
  // The increment must carry its own coverage, or a zero baseline that was
  // never measured is indistinguishable from one that was.
  assert.match(report, /baseline measured on 9 judgments, unavailable on 4/)
  // Nothing was evicted, so the retention line must stay out of the report.
  assert.doesNotMatch(report, /retained in memory/)
  assert.doesNotMatch(report, /write failures/)
})

test('an increment over an unmeasured baseline is not reported as a net gain', async () => {
  // The specific failure this guards: with no baseline measured, the report
  // used to print "the pruner would have removed 0 tokens" and then "net gain:
  // 39000" — a zero baseline that was never measured reading as a result.
  // Withholding the net number is the honest output.
  const report = await buildStatus(deps({
    ledger: stubLedger(
      {
        records: 15, judged: 15, savedTokens: 39_000,
        baselineSavedTokens: 0, netTokens: 39_000,
        baselineUnmeasured: 15, retained: 15,
      },
      { kind: 'domain', failures: 0 }
    ),
  }), 'agent-1')

  assert.match(report, /Total removed: 39000 tokens/)
  assert.match(report, /No baseline was measurable for any of the 15 prune judgments/)
  assert.doesNotMatch(report, /net gain from this plugin/)
  assert.doesNotMatch(report, /deterministic pruner would have removed/)
})

test('a memory-only ledger warns that the numbers reset', async () => {
  const report = await buildStatus(deps({
    ledger: stubLedger({ records: 3, retained: 3 }, { kind: 'memory', failures: 0 }),
  }), 'agent-1')
  assert.match(report, /Ledger store: memory only — the cumulative numbers reset on restart/)
  assert.doesNotMatch(report, /persistent/)
})

test('retention is visible without implying the counters shrank', async () => {
  // This is the whole reason the counters are stored separately: 1000 records
  // retained out of 4000 judged must not read as "only 1000 happened".
  const report = await buildStatus(deps({
    ledger: stubLedger(
      { records: 4_000, judged: 4_000, retained: 1_000, savedTokens: 500_000 },
      { kind: 'domain', failures: 0 }
    ),
  }), 'agent-1')
  assert.match(report, /4000 records cumulative/)
  assert.match(report, /1000 retained in memory/)
  assert.match(report, /the cumulative numbers are unaffected/)
})

test('persistence failures are reported without being called errors', async () => {
  const report = await buildStatus(deps({
    ledger: stubLedger({ records: 5, retained: 5 }, { kind: 'domain', failures: 3 }),
  }), 'agent-1')
  assert.match(report, /3 persistence write failures/)
  assert.match(report, /judging itself is unaffected/)
})

test('skip reasons and the most recent skips are reported, worst first', async () => {
  const entries = [
    makeRecord({ ts: 1, outcome: 'skipped', skip: 'no-task' }),
    makeRecord({ ts: 2, outcome: 'skipped', skip: 'no-task' }),
    makeRecord({ ts: 3, outcome: 'skipped', skip: 'too-small' }),
  ]
  const report = await buildStatus(deps({
    ledger: stubLedger({ records: 3, skipped: 3, retained: 3 }, { kind: 'memory', failures: 0 }, () => entries),
  }), 'agent-1')

  assert.match(report, /Skip reasons:/)
  const lines = report.split('\n')
  const noTask = lines.findIndex(line => line.includes('no-task × 2'))
  const tooSmall = lines.findIndex(line => line.includes('too-small × 1'))
  assert.ok(noTask >= 0 && tooSmall >= 0 && noTask < tooSmall, 'the most frequent reason must come first')
  assert.match(report, /Most recent skips:/)
})

test('the report follows the conversation language', async () => {
  const cache = createContextCache()
  cache.remember('zh-agent', '帮我看看这个配置文件')
  cache.remember('en-agent', 'please review this configuration file')

  const ledger = stubLedger({ records: 1, retained: 1 }, { kind: 'domain', failures: 0 })
  const chinese = await buildStatus(deps({ cache, ledger }), 'zh-agent')
  const english = await buildStatus(deps({ cache, ledger }), 'en-agent')

  assert.match(chinese, /dsh-jev-tools 状态/)
  assert.match(chinese, /台账存储：已持久化/)
  assert.match(english, /dsh-jev-tools status/)
  assert.match(english, /Ledger store: persistent/)
})

test('a switched-off ledger is reported as off, not as empty', async () => {
  // Otherwise "why is the ledger empty" has no answer in the one place a user
  // would look for it.
  const report = await buildStatus(deps({
    settings: () => resolveSettings({ ledger: { enabled: false } }),
    ledger: stubLedger({ records: 4, retained: 4 }, { kind: 'domain', failures: 0 }),
  }), 'agent-1')
  assert.match(report, /Ledger recording: \*\*off\*\*/)
  // The records made before the switch was flipped are still reported.
  assert.match(report, /4 records cumulative/)
})

test('screening and shadow state are both visible in the report', async () => {
  const report = await buildStatus(deps({
    settings: () => resolveSettings({
      prune: { shadow: true },
      screen: { threshold: 0.5, toolAllowlist: ['web_fetch'] },
    }),
    ledger: stubLedger({ records: 1, retained: 1 }, { kind: 'domain', failures: 0 }),
  }), 'agent-1')
  assert.match(report, /Injection screening: on \(threshold 0\.5/)
  assert.match(report, /allowlist web_fetch/)
  assert.match(report, /Pruning is in \*\*shadow mode\*\*/)
})

test('an unknown key is reported with where to get one', async () => {
  const report = await buildStatus(deps(), 'agent-1')
  assert.match(report, /not configured \(variable TYPESAFE_API_KEY\)/)
  assert.match(report, /console\.typesafe\.ai\/keys/)
  // The credentials service is absent in this profile, which is itself a cause
  // worth naming: "nothing happens" and "no key can ever be read" differ.
  assert.match(report, /credentials service is unavailable/)
})

test('the endpoint in force is named, because a wrong one looks like doing nothing', async () => {
  // Once `baseUrl` is configurable the destination stops being a constant, and
  // the report is the only place a user can confirm which host will be asked
  // without reading logs.
  const custom = await buildStatus(deps({
    settings: () => resolveSettings({ baseUrl: 'https://jev.example.com' }),
  }), 'agent-1')
  assert.match(custom, /Judgment endpoint: https:\/\/jev\.example\.com/)

  const plain = await buildStatus(deps(), 'agent-1')
  assert.match(plain, /Judgment endpoint: https:\/\/api\.typesafe\.ai/)
})

test('what it has cost is reported next to what it has saved', async () => {
  const report = await buildStatus(deps({
    ledger: stubLedger(
      { records: 12, judged: 12, retained: 12, spentTokens: 1_000_000, savedTokens: 40_000 },
      { kind: 'domain', failures: 0 }
    ),
  }), 'agent-1')
  // 1,000,000 input tokens at $0.042 per million, with the price named so the
  // number can be checked rather than trusted.
  assert.match(report, /Judgment cost: about \$0\.042000 \(1000000 input tokens cumulative at \$0\.042 per million/)
})

test('a plugin that has never judged does not claim a cost', async () => {
  // Zero is not a measurement worth a line, and the records counter above
  // already says the same thing without dressing it up as spend.
  const report = await buildStatus(deps({
    ledger: stubLedger({ records: 1, retained: 1 }, { kind: 'memory', failures: 0 }),
  }), 'agent-1')
  assert.doesNotMatch(report, /Judgment cost/)
})
