/**
 * Durable-ledger tests.
 *
 * The point of this file is the one property the in-memory ledger could not
 * have: **a restart is not a reset.** Everything else here protects the shapes
 * that property depends on — a schema tolerant enough to keep reading old
 * records, a key order that survives a round trip through the medium, and a
 * write path that can fail without ever failing a judgment.
 *
 * The fake domain below models the two behaviors the real facility provides
 * that this code actually relies on: the in-memory state is authoritative and
 * synchronous, and stored values are validated with the spec's own schema
 * before being handed over.
 *
 * @module dsh-jev-tools/test/ledger-domain
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createDomainLedger, judgmentSchema, ledgerDomainSpec, ledgerRecordKey, totalsSchema,
  DEFAULT_MAX_RECORDS, JUDGMENTS_TABLE, LEDGER_DOMAIN_NAME, LEDGER_DOMAIN_VERSION, TOTALS_KEY, TOTALS_TABLE,
} from '../lib/ledger-domain.js'
import { addToTotals, createGatedLedger, createLazyLedger, createMemoryLedger, EMPTY_TOTALS, type JudgmentRecord, type Ledger } from '../lib/ledger.js'

// ── a stand-in for the storage domain ───────────────────────────────────────

/** The durable state, surviving a simulated restart because it outlives the domain. */
interface Medium {
  readonly tables: Map<string, Map<string, unknown>>
  /** Documents a schema rejected, mirroring `invalidRecords: 'backup-and-skip'`. */
  readonly backedUp: string[]
}

/** Fresh, empty durable state. */
function createMedium (): Medium {
  return { tables: new Map(), backedUp: [] }
}

/** Table rules as the domain spec declares them, reduced to what is used here. */
interface SpecLike {
  readonly name: string
  readonly version: number
  readonly layout: string
  readonly invalidRecords: string
  readonly tables: Record<string, { readonly valueSchema: { parse (value: unknown): unknown } }>
}

/** One open domain over a {@link Medium}. */
class FakeDomain {
  readonly name: string
  /** Documents the schema rejected on this open. */
  readonly rejected: string[] = []
  /** When positive, the next N `put`/`delete` calls reject. */
  failNext = 0
  /** Every write this domain was asked to perform, in order. */
  readonly writes: string[] = []
  private readonly tables = new Map<string, Map<string, unknown>>()

  constructor (name: string, medium: Medium, spec: SpecLike) {
    this.name = name
    for (const [table, declaration] of Object.entries(spec.tables)) {
      const stored = medium.tables.get(table) ?? new Map<string, unknown>()
      const accepted = new Map<string, unknown>()
      // The real facility validates every stored record at the durable
      // boundary; a rejected record is moved aside, not fatal.
      for (const [key, raw] of stored) {
        try {
          accepted.set(key, declaration.valueSchema.parse(raw))
        } catch {
          this.rejected.push(`${table}/${key}`)
          medium.backedUp.push(`${table}/${key}`)
        }
      }
      medium.tables.set(table, accepted)
      this.tables.set(table, accepted)
    }
  }

  table (name: string): {
    get: (key: string) => unknown
    entries: () => IterableIterator<[string, unknown]>
    keys: () => IterableIterator<string>
    readonly size: number
    put: (key: string, value: unknown) => Promise<void>
    delete: (key: string) => Promise<boolean>
    update: (key: string, fn: (current: unknown) => unknown) => Promise<unknown>
  } {
    const store = this.tables.get(name)
    if (store === undefined) throw new Error(`undeclared table '${name}'`)
    const fail = (): void => {
      if (this.failNext > 0) {
        this.failNext -= 1
        throw new Error('medium is unavailable')
      }
    }
    return {
      get: key => store.get(key),
      entries: () => store.entries(),
      keys: () => store.keys(),
      get size () { return store.size },
      put: async (key, value) => { this.writes.push(`put:${name}/${key}`); fail(); store.set(key, value) },
      delete: async key => { this.writes.push(`delete:${name}/${key}`); fail(); return store.delete(key) },
      update: async (key, fn) => {
        this.writes.push(`update:${name}/${key}`)
        fail()
        const next = fn(store.get(key))
        store.set(key, next)
        return next
      },
    }
  }

  close (): Promise<void> {
    return Promise.resolve()
  }
}

/** Read a table's live map, for asserting what is actually durable. */
const mediumTable = (medium: Medium, name: string): Map<string, unknown> =>
  medium.tables.get(name) ?? new Map<string, unknown>()

/** Poll until `check` holds. Durability is asynchronous; assertions about it must not assume a tick count. */
async function eventually (check: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail(`timed out waiting for ${label}`)
}

/** A minimal judgment record. */
function record (overrides: Partial<JudgmentRecord> = {}): JudgmentRecord {
  return {
    ts: 1_000,
    agentId: 'agent-1',
    feature: 'prune',
    backendId: 'jev',
    model: 'jev-1.13.0',
    latencyMs: 120,
    outcome: 'judged',
    ...overrides,
  }
}

// ── the declaration ─────────────────────────────────────────────────────────

test('the domain declaration matches what the durable boundary validates', () => {
  const spec = ledgerDomainSpec()
  // `UNIT_NAME_RE` is /^[a-z][a-z0-9_]*$/ and doubles as the backend unit name,
  // which is also a file-name segment.
  assert.match(spec.name, /^[a-z][a-z0-9_]*$/)
  assert.equal(spec.name, LEDGER_DOMAIN_NAME)
  assert.equal(spec.version, LEDGER_DOMAIN_VERSION)
  assert.ok(Number.isInteger(spec.version) && spec.version >= 0)
  // Disposable derived data: one bad document must cost that document, never the history.
  assert.equal(spec.layout, 'per-record')
  assert.equal(spec.invalidRecords, 'backup-and-skip')
  for (const table of Object.keys(spec.tables)) assert.match(table, /^[a-z][a-z0-9_]*$/)
  assert.deepEqual(Object.keys(spec.tables).sort(), [JUDGMENTS_TABLE, TOTALS_TABLE])
  assert.equal(typeof spec.tables[JUDGMENTS_TABLE]?.valueSchema.parse, 'function')
  assert.equal(typeof spec.tables[TOTALS_TABLE]?.valueSchema.parse, 'function')
  // `defineDomain` rejects a global schema that accepts null; declaring no
  // global at all is how the ledger avoids that whole failure class.
  assert.equal('global' in spec, false)
})

// ── the schemas ─────────────────────────────────────────────────────────────

test('a stored judgment round-trips, and unknown keys are dropped rather than rejected', () => {
  const schema = judgmentSchema()
  const full = record({ requestedModel: 'jev-latest', inputTokens: 900, skip: 'no-key', originalTokens: 10, baselineKeptTokens: 6, keptTokens: 4, segments: 3, segmentsKept: 2 })
  assert.deepEqual(schema.parse(full), full)
  // A record written by a newer release must stay readable by this one: an
  // additive change cannot be allowed to make every old record invalid.
  const fromTheFuture = { ...full, probability: 0.93, novelty: { tier: 2 } }
  const parsed = schema.parse(fromTheFuture) as Record<string, unknown>
  assert.equal(parsed.probability, undefined)
  assert.equal(parsed.novelty, undefined)
  assert.deepEqual(parsed, full)
})

test('the judgment schema rejects a record it cannot vouch for', () => {
  const schema = judgmentSchema()
  const required: ReadonlyArray<readonly [string, unknown]> = [
    ['a non-object', 'not a record'],
    ['an array', []],
    ['a missing timestamp', { ...record(), ts: undefined }],
    ['a non-numeric timestamp', { ...record(), ts: '1000' }],
    ['a non-finite timestamp', { ...record(), ts: Number.POSITIVE_INFINITY }],
    ['an unknown feature', { ...record(), feature: 'teleport' }],
    ['an unknown outcome', { ...record(), outcome: 'maybe' }],
    ['a missing agent', { ...record(), agentId: undefined }],
    ['a negative-latency reading expressed as text', { ...record(), latencyMs: 'fast' }],
  ]
  for (const [label, value] of required) {
    const result = schema.safeParse(value)
    assert.equal(result.success, false, `${label} should not parse`)
    assert.ok(result.success === false && result.error.message.includes('judgment record'))
  }
})

test('an unknown skip reason stays readable, because reasons are added over time', () => {
  const schema = judgmentSchema()
  const parsed = schema.parse(record({ outcome: 'skipped', skip: 'invented-in-v0.2' as never }))
  assert.equal(parsed.skip, 'invented-in-v0.2')
})

test('the totals schema validates the counters row', () => {
  const schema = totalsSchema()
  assert.deepEqual(schema.parse(EMPTY_TOTALS), EMPTY_TOTALS)
  assert.equal(schema.safeParse({ ...EMPTY_TOTALS, savedTokens: 'lots' }).success, false)
  assert.equal(schema.safeParse({ records: 1 }).success, false)
})

// ── record keys ─────────────────────────────────────────────────────────────

test('record keys are path-safe and sort in time order', () => {
  // A per-record backend uses the key as a file name and rejects anything
  // outside /^[a-zA-Z0-9_-]+$/, so a colon or a dot would break persistence.
  const stamps = [1_700_000_000_000, 1_700_000_000_001, 999, 20_000_000_000_000].sort((a, b) => a - b)
  const keys = stamps.map(ledgerRecordKey)
  for (const key of keys) assert.match(key, /^[a-zA-Z0-9_-]+$/)
  assert.equal(new Set(keys).size, keys.length)
  assert.deepEqual([...keys].sort(), keys, 'later timestamps must sort later')
})

// ── the ledger ──────────────────────────────────────────────────────────────

test('a cold ledger reports nothing and materializes its counters row', async () => {
  const medium = createMedium()
  const domain = new FakeDomain(LEDGER_DOMAIN_NAME, medium, ledgerDomainSpec())
  const ledger = createDomainLedger({ domain })

  assert.equal(ledger.size, 0)
  assert.deepEqual(ledger.entries(), [])
  assert.deepEqual(ledger.summary(), { ...EMPTY_TOTALS, retained: 0, models: {} })
  assert.deepEqual(ledger.store, { kind: 'domain', failures: 0 })
  await eventually(() => mediumTable(medium, TOTALS_TABLE).get(TOTALS_KEY) !== undefined, 'the initial counters row')
  assert.deepEqual(mediumTable(medium, TOTALS_TABLE).get(TOTALS_KEY), EMPTY_TOTALS)
})

test('records accumulate, and the A/B increment is separated from the baseline', () => {
  const medium = createMedium()
  const domain = new FakeDomain(LEDGER_DOMAIN_NAME, medium, ledgerDomainSpec())
  const ledger = createDomainLedger({ domain })

  // 1000 tokens in, the deterministic pruner would have kept 700, semantic
  // selection kept 400: 600 removed, of which 300 the baseline would have taken.
  ledger.record(record({ ts: 1, originalTokens: 1_000, baselineKeptTokens: 700, keptTokens: 400, segments: 5, segmentsKept: 2 }))
  ledger.record(record({ ts: 2, feature: 'prune', outcome: 'skipped', skip: 'too-small' }))
  ledger.record(record({ ts: 3, feature: 'suggest', outcome: 'judged' }))

  const summary = ledger.summary()
  assert.equal(summary.records, 3)
  assert.equal(summary.retained, 3)
  assert.equal(summary.judged, 2)
  assert.equal(summary.skipped, 1)
  assert.equal(summary.savedTokens, 600)
  // The baseline kept 700 of 1000, so it would have removed 300 of the 600.
  assert.equal(summary.baselineSavedTokens, 300)
  // The increment is what semantic selection removed beyond that: 300.
  assert.equal(summary.netTokens, 300)
  assert.deepEqual(summary.models, { 'jev-1.13.0': 3 })
})

test('input tokens accumulate into the spend counter', () => {
  const medium = createMedium()
  const domain = new FakeDomain(LEDGER_DOMAIN_NAME, medium, ledgerDomainSpec())
  const ledger = createDomainLedger({ domain })

  ledger.record(record({ ts: 1, inputTokens: 1_200 }))
  ledger.record(record({ ts: 2, feature: 'suggest', outcome: 'judged', inputTokens: 800 }))
  ledger.record(record({ ts: 3, feature: 'prune', outcome: 'skipped', skip: 'no-key' }))

  // Input is the only thing billed, and a declined attempt carries no usage —
  // nothing was sent, so nothing was charged.
  assert.equal(ledger.summary().spentTokens, 2_000)
})

test('a counters row written before the spend counter still loads', () => {
  // Adding a *required* field would make an older row fail validation, and with
  // `invalidRecords: 'backup-and-skip'` that would move the row aside — quietly
  // discarding the cumulative history it exists to carry. The field is optional
  // for exactly this reason, so the test asserts the old row is accepted.
  const medium = createMedium()
  const older = { records: 5, judged: 4, skipped: 1, savedTokens: 100, baselineSavedTokens: 40, netTokens: 60 }
  medium.tables.set(TOTALS_TABLE, new Map([[TOTALS_KEY, older]]))
  const domain = new FakeDomain(LEDGER_DOMAIN_NAME, medium, ledgerDomainSpec())
  const ledger = createDomainLedger({ domain })

  assert.deepEqual(domain.rejected, [], 'the older row must not be backed up')
  const summary = ledger.summary()
  assert.equal(summary.records, 5, 'the counters that were carried survive')
  assert.equal(summary.savedTokens, 100)
  assert.equal(summary.spentTokens, 0, 'a counter the old row cannot carry reads as zero')
})

test('a record with no baseline measurement credits the whole saving to this plugin', () => {
  // An absent baseline means the deterministic pruner was not there to measure,
  // so it would have removed nothing. Attributing the saving elsewhere would
  // understate the plugin; inventing a partial baseline would be fabrication.
  const folded = addToTotals(EMPTY_TOTALS, record({ originalTokens: 1_000, keptTokens: 400 }))
  assert.equal(folded.savedTokens, 600)
  assert.equal(folded.baselineSavedTokens, 0)
  assert.equal(folded.netTokens, 600)
  // The split must always add up, or the report shows three numbers that
  // cannot be reconciled with each other.
  assert.equal(folded.savedTokens, folded.baselineSavedTokens + folded.netTokens)
})

test('a restart is not a reset: counters and records survive a reopen', async () => {
  const medium = createMedium()
  const firstDomain = new FakeDomain(LEDGER_DOMAIN_NAME, medium, ledgerDomainSpec())
  const first = createDomainLedger({ domain: firstDomain })
  first.record(record({ ts: 1_000, originalTokens: 1_000, baselineKeptTokens: 700, keptTokens: 400 }))
  first.record(record({ ts: 2_000, agentId: 'agent-2', feature: 'prune', outcome: 'skipped', skip: 'no-task' }))
  await eventually(() => mediumTable(medium, JUDGMENTS_TABLE).size === 2, 'both records to land durably')

  // A new open over the same durable state is exactly what a host restart is.
  const secondDomain = new FakeDomain(LEDGER_DOMAIN_NAME, medium, ledgerDomainSpec())
  const second = createDomainLedger({ domain: secondDomain })

  assert.deepEqual(secondDomain.rejected, [], 'nothing should have needed backing up')
  assert.deepEqual(second.entries(), first.entries())
  assert.deepEqual(second.summary(), first.summary())
  assert.equal(second.summary().records, 2)
  assert.equal(second.summary().savedTokens, 600)
  assert.equal(second.size, 2)
})

test('records load in time order regardless of how the medium hands them over', () => {
  const medium = createMedium()
  // Deliberately out of order, as a directory scan may well be.
  medium.tables.set(JUDGMENTS_TABLE, new Map([
    [ledgerRecordKey(3_000), record({ ts: 3_000, agentId: 'c' })],
    [ledgerRecordKey(1_000), record({ ts: 1_000, agentId: 'a' })],
    [ledgerRecordKey(2_000), record({ ts: 2_000, agentId: 'b' })],
  ]))
  const domain = new FakeDomain(LEDGER_DOMAIN_NAME, medium, ledgerDomainSpec())
  const ledger = createDomainLedger({ domain })
  assert.deepEqual(ledger.entries().map(entry => entry.agentId), ['a', 'b', 'c'])
})

test('counters fall back to the retained records when the counters row is missing', () => {
  const medium = createMedium()
  medium.tables.set(JUDGMENTS_TABLE, new Map([
    [ledgerRecordKey(1_000), record({ ts: 1_000, originalTokens: 500, baselineKeptTokens: 400, keptTokens: 200 })],
  ]))
  const domain = new FakeDomain(LEDGER_DOMAIN_NAME, medium, ledgerDomainSpec())
  const ledger = createDomainLedger({ domain })
  const summary = ledger.summary()
  assert.equal(summary.records, 1)
  assert.equal(summary.savedTokens, 300)
  assert.equal(summary.baselineSavedTokens, 100)
  assert.equal(summary.netTokens, 200)
})

test('retention drops the oldest records from memory and from the medium', async () => {
  const medium = createMedium()
  const domain = new FakeDomain(LEDGER_DOMAIN_NAME, medium, ledgerDomainSpec())
  const ledger = createDomainLedger({ domain, maxRecords: 3 })

  for (let i = 1; i <= 5; i += 1) ledger.record(record({ ts: i * 1_000, agentId: `agent-${i}` }))

  assert.equal(ledger.size, 3)
  assert.deepEqual(ledger.entries().map(entry => entry.agentId), ['agent-3', 'agent-4', 'agent-5'])
  // Cumulative counters are the reason retention may not simply recompute:
  // evicting two records must not reduce what the plugin has saved.
  assert.equal(ledger.summary().records, 5)
  assert.equal(ledger.summary().retained, 3)
  await eventually(() => mediumTable(medium, JUDGMENTS_TABLE).size === 3, 'the evicted documents to be deleted')
  assert.equal(mediumTable(medium, TOTALS_TABLE).get(TOTALS_KEY) !== undefined, true)
  assert.equal((mediumTable(medium, TOTALS_TABLE).get(TOTALS_KEY) as { records: number }).records, 5)
})

test('retention is applied to what the previous run left behind too', async () => {
  const medium = createMedium()
  const previous = new Map<string, unknown>()
  for (let i = 1; i <= 6; i += 1) {
    previous.set(ledgerRecordKey(i * 1_000), record({ ts: i * 1_000, agentId: `old-${i}` }))
  }
  medium.tables.set(JUDGMENTS_TABLE, previous)
  const domain = new FakeDomain(LEDGER_DOMAIN_NAME, medium, ledgerDomainSpec())
  const ledger = createDomainLedger({ domain, maxRecords: 2 })

  assert.deepEqual(ledger.entries().map(entry => entry.agentId), ['old-5', 'old-6'])
  // The counters row was never written, so the survivors are the only evidence.
  assert.equal(ledger.summary().records, 2)
  await eventually(() => mediumTable(medium, JUDGMENTS_TABLE).size === 2, 'the stale documents to be deleted')
})

// ── failure isolation ───────────────────────────────────────────────────────

test('a failing medium degrades the ledger and never the judgment', async () => {
  const medium = createMedium()
  const domain = new FakeDomain(LEDGER_DOMAIN_NAME, medium, ledgerDomainSpec())
  const ledger = createDomainLedger({ domain })

  // Let the constructor's counters row land first: otherwise the injected
  // failure would be consumed by that write instead of the record under test.
  await eventually(() => mediumTable(medium, TOTALS_TABLE).has(TOTALS_KEY), 'the initial counters row')
  assert.equal(ledger.store.failures, 0)

  domain.failNext = 1
  // `record` is synchronous and must stay that way: it is called from inside a
  // tool-result listener, where a throw would fail the tool call.
  ledger.record(record({ ts: 1_000, agentId: 'lost' }))
  await eventually(() => ledger.store.failures === 1, 'the failure to be counted')
  // The rejected unit wrote nothing: the row and the counters travel together,
  // so the durable counters still read zero rather than drifting ahead.
  assert.equal(mediumTable(medium, JUDGMENTS_TABLE).size, 0)
  assert.equal((mediumTable(medium, TOTALS_TABLE).get(TOTALS_KEY) as { records: number }).records, 0)

  // Reads stay correct regardless: the in-memory state is authoritative.
  assert.equal(ledger.summary().records, 1)

  // And the chain survives: the next write lands.
  ledger.record(record({ ts: 2_000, agentId: 'kept' }))
  await eventually(
    () => [...mediumTable(medium, JUDGMENTS_TABLE).values()].some(value => (value as JudgmentRecord).agentId === 'kept'),
    'the write after a failure to land'
  )
  assert.equal(ledger.store.kind, 'domain')
})

test('a record the schema cannot vouch for is backed up rather than fatal', () => {
  const medium = createMedium()
  // Keys are minted from a process-wide sequence, so they must be generated
  // once and reused rather than recomputed.
  const goodKey = ledgerRecordKey(1_000)
  const corruptKey = ledgerRecordKey(2_000)
  medium.tables.set(JUDGMENTS_TABLE, new Map([
    [goodKey, record({ ts: 1_000, agentId: 'good' })],
    [corruptKey, { ts: 2_000, agentId: 'corrupt', feature: 'not-a-feature' }],
  ]))
  const domain = new FakeDomain(LEDGER_DOMAIN_NAME, medium, ledgerDomainSpec())
  const ledger = createDomainLedger({ domain })

  // The spec opts into `backup-and-skip`, so the mount survives one bad record.
  assert.deepEqual(domain.rejected, [`${JUDGMENTS_TABLE}/${corruptKey}`])
  assert.deepEqual(ledger.entries().map(entry => entry.agentId), ['good'])
})

// ── the in-place upgrade ────────────────────────────────────────────────────

test('the ledger handle survives the upgrade, replaying what was judged while the domain opened', async () => {
  const medium = createMedium()
  const domain = new FakeDomain(LEDGER_DOMAIN_NAME, medium, ledgerDomainSpec())
  const lazy = createLazyLedger()

  // Judged before persistence was ready — the async open window.
  lazy.ledger.record(record({ ts: 1_000, agentId: 'early', originalTokens: 1_000, baselineKeptTokens: 700, keptTokens: 400 }))
  assert.equal(lazy.ledger.store.kind, 'memory')
  assert.equal(lazy.ledger.summary().records, 1)

  const durable = createDomainLedger({ domain })
  lazy.attach(durable)

  assert.equal(lazy.ledger.store.kind, 'domain')
  assert.deepEqual(lazy.ledger.entries(), durable.entries())
  assert.equal(lazy.ledger.summary().records, 1)
  assert.equal(lazy.ledger.summary().savedTokens, 600)
  await eventually(() => mediumTable(medium, JUDGMENTS_TABLE).size === 1, 'the buffered record to be replayed durably')

  // After the swap the handle keeps working through the durable ledger.
  lazy.ledger.record(record({ ts: 2_000, agentId: 'late' }))
  assert.equal(durable.summary().records, 2)
  assert.equal(lazy.ledger.size, 2)
})

test('attaching twice cannot double-count', () => {
  const medium = createMedium()
  const lazy = createLazyLedger()
  lazy.ledger.record(record({ ts: 1_000 }))
  const durable = createDomainLedger({ domain: new FakeDomain(LEDGER_DOMAIN_NAME, medium, ledgerDomainSpec()) })
  lazy.attach(durable)
  lazy.attach(durable)
  assert.equal(lazy.ledger.summary().records, 1)
})

test('a ledger that never gets a domain still answers every question', () => {
  const lazy = createLazyLedger()
  lazy.ledger.record(record({ ts: 1_000 }))
  assert.equal(lazy.ledger.store.kind, 'memory')
  assert.equal(lazy.ledger.store.failures, 0)
  assert.equal(lazy.ledger.summary().records, 1)
  assert.equal(lazy.ledger.entries().length, 1)
})

// ── the two implementations must agree ──────────────────────────────────────

test('the memory and domain ledgers summarize identical input identically', async () => {
  const medium = createMedium()
  const domain = new FakeDomain(LEDGER_DOMAIN_NAME, medium, ledgerDomainSpec())
  const durable = createDomainLedger({ domain })
  const memory: Ledger = createMemoryLedger()
  const input: JudgmentRecord[] = [
    record({ ts: 1, originalTokens: 1_000, baselineKeptTokens: 700, keptTokens: 400 }),
    record({ ts: 2, feature: 'prune', outcome: 'skipped', skip: 'too-small' }),
    record({ ts: 3, feature: 'tool', outcome: 'judged', model: '', inputTokens: 12 }),
    record({ ts: 4, originalTokens: 300, keptTokens: 300 }),
  ]
  for (const entry of input) {
    durable.record(entry)
    memory.record(entry)
  }
  assert.deepEqual(durable.summary(), memory.summary())
  assert.deepEqual(durable.entries(), memory.entries())
})

test('the default retention ceiling is the documented one', () => {
  assert.equal(DEFAULT_MAX_RECORDS, 1_000)
})

// ── the runtime switch ──────────────────────────────────────────────────────

test('switching the ledger off stops new records without hiding the old ones', () => {
  // `ledger.enabled` is user-facing, so it has to do something. A switch that
  // only took effect after a restart would be the same lie in a slower form.
  const inner = createMemoryLedger()
  let enabled = true
  const ledger = createGatedLedger(inner, () => enabled)

  ledger.record(record({ ts: 1_000, agentId: 'before' }))
  enabled = false
  ledger.record(record({ ts: 2_000, agentId: 'during' }))

  assert.deepEqual(ledger.entries().map(entry => entry.agentId), ['before'])
  assert.equal(ledger.summary().records, 1)

  enabled = true
  ledger.record(record({ ts: 3_000, agentId: 'after' }))
  assert.deepEqual(ledger.entries().map(entry => entry.agentId), ['before', 'after'])
  // Reads are never gated: a user who turns recording off must still be able to
  // see what was recorded before.
  assert.equal(ledger.store.kind, 'memory')
})
