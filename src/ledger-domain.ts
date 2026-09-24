/**
 * Durable backing for the judgment ledger.
 *
 * The ledger previously lived only in memory, which made the two numbers it
 * exists to produce reset on every restart: the cumulative tokens removed and,
 * more importantly, the A/B split between what DSH's deterministic pruner would
 * have cut anyway and what semantic selection added on top. A saving you have
 * to re-earn every session is not a measurement.
 *
 * ## Why the schema is hand-written
 *
 * A domain spec declares record schemas as **zod** types. This module does not
 * import zod, for two reasons that both showed up as hard constraints:
 *
 *   1. This package is installed into a profile as a junction/link, and Node's
 *      ESM loader realpaths the importing module. A bare `import 'zod'` from
 *      `lib/ledger-domain.js` therefore resolves against the *workspace* tree,
 *      where zod is not installed, and fails with `ERR_MODULE_NOT_FOUND` —
 *      verified, not assumed.
 *   2. Declaring zod a dependency would turn a fail-open bookkeeping feature
 *      into an install-time requirement.
 *
 * What the durable boundary actually does with a table's `valueSchema` is one
 * call — `tableSpec.valueSchema.parse(raw)` — at
 * `packages/storage/storage-domain/lib/index.js:371`, and `descriptorOf` reads
 * only `Object.keys(spec.tables)`. Nothing introspects the schema, and nothing
 * checks `instanceof ZodType`. So a structural validator with the same surface
 * satisfies the contract, exactly as `src/host.ts` satisfies the service
 * contracts structurally instead of importing lagging npm types.
 *
 * ## Layout and durability choices
 *
 * - `per-record`: one document per judgment under
 *   `<storageRoot>/dsh_jev_tools/judgments/<key>.json`. A record that fails to
 *   parse costs that record, not the history.
 * - `invalidRecords: 'backup-and-skip'`: the ledger is disposable derived data,
 *   so a corrupt document must never cost the mount; the backend moves it aside
 *   and continues.
 * - `record()` is synchronous but `put()` is not, so writes go onto a single
 *   serialized best-effort chain. A failed write increments a counter and never
 *   surfaces into a tool call or a step.
 * - Writes are serialized, so reading the totals row back and writing it
 *   forward is safe within this process without `table.update`.
 *
 * @module dsh-jev-tools/ledger-domain
 */

import { addToTotals, EMPTY_TOTALS, summarize, totalsOf, type JudgmentRecord, type Ledger, type LedgerTotals } from './ledger.js'
import type { DomainLike, DomainTableLike } from './host.js'

/** Domain name on the medium. Must match `/^[a-z][a-z0-9_]*$/`. */
export const LEDGER_DOMAIN_NAME = 'dsh_jev_tools'

/**
 * Domain format version.
 *
 * `per-record` scopes the version check per document: a record stamped with an
 * unlisted version is discarded rather than migrated. **When bumping this,
 * add the old value to `compatibleVersions`** if the records are still
 * structurally valid — the schema drops unknown keys and defaults nothing, so
 * an additive change keeps old records readable.
 */
export const LEDGER_DOMAIN_VERSION = 1

/** Table holding one document per judgment. */
export const JUDGMENTS_TABLE = 'judgments'

/** Table holding the cumulative counters as a single row. */
export const TOTALS_TABLE = 'totals'

/** Key of the single counters row. */
export const TOTALS_KEY = 'totals'

/**
 * Ceiling on both the in-memory mirror and the documents on the medium.
 *
 * `per-record` means `open()` reads every document, so this is a mount-cost
 * knob as much as a disk one: 1,000 records is a few hundred kilobytes and a
 * few hundred milliseconds, and takes a long time to reach — a heavy session
 * produces tens of records, not thousands.
 */
export const DEFAULT_MAX_RECORDS = 1_000

/**
 * The one method the durable boundary calls on a record schema, plus the
 * conventional alternative a future version might reach for.
 */
export interface RecordSchema<T> {
  parse (value: unknown): T
  safeParse (value: unknown): { readonly success: true, readonly data: T }
    | { readonly success: false, readonly error: Error }
}

/** One field of a flat record schema. */
interface FieldRule {
  readonly key: string
  readonly kind: 'string' | 'number' | 'enum'
  /** Permitted values, for `kind: 'enum'`. */
  readonly values?: readonly string[]
  readonly optional?: boolean
}

/** Throw a validation failure attributed to the record type. */
function fail (label: string, message: string): never {
  throw new Error(`${label}: ${message}`)
}

/**
 * Build a flat-object validator.
 *
 * Unknown keys are **dropped, not rejected**. A record written by a newer
 * release of this plugin must stay readable by an older one, and nothing here
 * round-trips a field it does not understand, so dropping is the migration-safe
 * choice: without it, adding a field in v0.2 would make every v0.1 record fail
 * validation and be backed up on the next mount.
 *
 * @param label - how validation failures name the record type.
 * @param fields - the rules, applied in order.
 * @returns the schema.
 */
function makeSchema<T> (label: string, fields: readonly FieldRule[]): RecordSchema<T> {
  const parse = (value: unknown): T => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      fail(label, `expected an object, got ${Array.isArray(value) ? 'an array' : typeof value}`)
    }
    const source = value as Record<string, unknown>
    const output: Record<string, unknown> = {}
    for (const field of fields) {
      const raw = source[field.key]
      if (raw === undefined || raw === null) {
        if (field.optional === true) continue
        fail(label, `"${field.key}" is required`)
      }
      if (field.kind === 'number') {
        if (typeof raw !== 'number' || !Number.isFinite(raw)) {
          fail(label, `"${field.key}" must be a finite number`)
        }
        output[field.key] = raw
        continue
      }
      if (typeof raw !== 'string') fail(label, `"${field.key}" must be a string`)
      if (field.values !== undefined && !field.values.includes(raw)) {
        fail(label, `"${field.key}" must be one of ${field.values.join('|')}, got "${raw}"`)
      }
      output[field.key] = raw
    }
    return output as unknown as T
  }
  return {
    parse,
    safeParse (value) {
      try {
        return { success: true, data: parse(value) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error : new Error(String(error)) }
      }
    },
  }
}

/**
 * Features a record may name.
 *
 * Adding a value is safe for older records (they are validated against the same
 * list, which only grows). Removing one is not: records naming it would fail
 * validation and be backed up on the next mount.
 */
const FEATURES: readonly string[] = ['prune', 'suggest', 'screen', 'tool', 'command']

/** Outcomes a record may have. */
const OUTCOMES: readonly string[] = ['judged', 'skipped']

/**
 * The stored judgment schema.
 *
 * `skip` is deliberately a free string rather than an enum of today's reasons:
 * a release that adds a skip reason must not make the previous release's
 * records unreadable.
 *
 * @returns the schema.
 */
export function judgmentSchema (): RecordSchema<JudgmentRecord> {
  return makeSchema<JudgmentRecord>('judgment record', [
    { key: 'ts', kind: 'number' },
    { key: 'agentId', kind: 'string' },
    { key: 'feature', kind: 'enum', values: FEATURES },
    { key: 'backendId', kind: 'string' },
    { key: 'model', kind: 'string' },
    { key: 'requestedModel', kind: 'string', optional: true },
    { key: 'latencyMs', kind: 'number' },
    { key: 'inputTokens', kind: 'number', optional: true },
    { key: 'outcome', kind: 'enum', values: OUTCOMES },
    { key: 'skip', kind: 'string', optional: true },
    { key: 'originalTokens', kind: 'number', optional: true },
    { key: 'baselineKeptTokens', kind: 'number', optional: true },
    // A free string rather than an enum of today's reasons, for the same reason
    // as `skip`: a later release adding a reason must not make this release's
    // records unreadable.
    { key: 'baselineUnavailable', kind: 'string', optional: true },
    { key: 'keptTokens', kind: 'number', optional: true },
    { key: 'segments', kind: 'number', optional: true },
    { key: 'segmentsKept', kind: 'number', optional: true },
  ])
}

/**
 * The stored counters schema.
 *
 * `spentTokens` is **optional on purpose**. Adding a required field would make
 * every counters row written by an earlier release fail validation, and with
 * `invalidRecords: 'backup-and-skip'` that row would be moved aside — silently
 * discarding the cumulative history the row exists to carry. Optional means an
 * old row still parses, and the reader fills the gap with zero.
 *
 * `baselineMeasured` / `baselineUnmeasured` are optional for the same reason.
 * A row written before they existed reports zero coverage, which is the
 * conservative reading: an old increment is treated as unproven rather than
 * being credited with baselines that were never counted.
 *
 * @returns the schema.
 */
export function totalsSchema (): RecordSchema<LedgerTotals> {
  return makeSchema<LedgerTotals>('ledger totals', [
    { key: 'records', kind: 'number' },
    { key: 'judged', kind: 'number' },
    { key: 'skipped', kind: 'number' },
    { key: 'savedTokens', kind: 'number' },
    { key: 'baselineSavedTokens', kind: 'number' },
    { key: 'netTokens', kind: 'number' },
    { key: 'baselineMeasured', kind: 'number', optional: true },
    { key: 'baselineUnmeasured', kind: 'number', optional: true },
    { key: 'spentTokens', kind: 'number', optional: true },
  ])
}

/** One declared table, as the domain facility reads it. */
export interface DomainTableSpecLike {
  readonly valueSchema: RecordSchema<unknown>
}

/** The domain declaration, written as a literal rather than via `defineDomain`. */
export interface DomainSpecLike {
  readonly name: string
  readonly version: number
  readonly layout: 'single' | 'per-record'
  readonly invalidRecords: 'backup-and-skip'
  readonly tables: Record<string, DomainTableSpecLike>
}

/**
 * Build the domain declaration.
 *
 * `defineDomain` is only a validator, so the spec is passed to `open()` as an
 * ordinary object; the field set below is what that validator checks.
 *
 * @returns a fresh spec object.
 */
export function ledgerDomainSpec (): DomainSpecLike {
  return {
    name: LEDGER_DOMAIN_NAME,
    version: LEDGER_DOMAIN_VERSION,
    layout: 'per-record',
    invalidRecords: 'backup-and-skip',
    tables: {
      [JUDGMENTS_TABLE]: { valueSchema: judgmentSchema() },
      [TOTALS_TABLE]: { valueSchema: totalsSchema() },
    },
  }
}

/** Width of the timestamp segment, generous enough that the key never re-sorts. */
const KEY_TS_DIGITS = 16

/** Width of the per-process sequence segment. */
const KEY_SEQ_DIGITS = 8

/** Process-wide, so two ledgers in one process cannot collide within a millisecond. */
let keySequence = 0

/**
 * Build a record key that sorts in time order.
 *
 * A per-record backend uses the key as a file name, so it must match
 * `/^[a-zA-Z0-9_-]+$/` (the backend rejects anything else) — which rules out
 * ISO timestamps and colons.
 *
 * @param ts - the record's timestamp in milliseconds.
 * @returns a path-safe, lexicographically ordered key.
 */
export function ledgerRecordKey (ts: number): string {
  keySequence += 1
  const stamp = String(Math.max(0, Math.trunc(ts))).padStart(KEY_TS_DIGITS, '0')
  return `${stamp}-${String(keySequence).padStart(KEY_SEQ_DIGITS, '0')}`
}

/** Everything {@link createDomainLedger} needs. */
export interface DomainLedgerOptions {
  /** The opened domain. The caller owns it and must close it. */
  readonly domain: DomainLike
  /** Ceiling on retained records, mirroring `DEFAULT_MAX_RECORDS`. */
  readonly maxRecords?: number
  /** Sink for best-effort write failures. Defaults to silence. */
  readonly log?: (message: string) => void
}

/**
 * Create a ledger backed by an open storage domain.
 *
 * The domain's in-memory state is authoritative and already loaded by `open()`,
 * so this constructor is synchronous and every read is synchronous; only
 * durability is asynchronous, and it is best-effort.
 *
 * @param options - the domain, retention ceiling, and failure sink.
 * @returns the ledger.
 */
export function createDomainLedger (options: DomainLedgerOptions): Ledger {
  const maxRecords = Math.max(1, Math.trunc(options.maxRecords ?? DEFAULT_MAX_RECORDS))
  const log = options.log ?? ((): void => {})
  const domain = options.domain
  const judgments = domain.table(JUDGMENTS_TABLE) as unknown as DomainTableLike<JudgmentRecord>
  const totalsTable = domain.table(TOTALS_TABLE) as unknown as DomainTableLike<LedgerTotals>

  // Map order comes from the medium and is not a contract; the keys are time
  // ordered, so sorting the keys sorts the history.
  const loaded = [...judgments.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const excess = Math.max(0, loaded.length - maxRecords)
  const rows = loaded.slice(excess).map(([key, value]) => ({ key, value }))
  const stored = totalsTable.get(TOTALS_KEY)
  // No stored counters means either a first run or a run that predates the
  // totals table; the retained records are the only evidence available.
  // A stored row is merged over the zero value so a counter added by a later
  // release (which the old row cannot carry) reads as zero instead of undefined.
  let totals: LedgerTotals = stored === undefined
    ? totalsOf(rows.map(row => row.value))
    : { ...EMPTY_TOTALS, ...stored }

  let failures = 0
  let chain: Promise<void> = Promise.resolve()

  /**
   * Append one durable unit of work to the write chain.
   *
   * The rejection handler resolves the chain, so one failed write neither
   * rethrows into `record()` nor breaks the writes queued behind it.
   */
  const enqueue = (work: () => Promise<unknown>): void => {
    chain = chain.then(work).then(
      () => undefined,
      (error: unknown) => {
        failures += 1
        log(`ledger write failed: ${String(error)}`)
      },
    )
  }

  // Repair what the previous run left behind, off the mount path.
  if (excess > 0) {
    const stale = loaded.slice(0, excess).map(([key]) => key)
    enqueue(async () => {
      for (const key of stale) await judgments.delete(key)
    })
  }
  if (stored === undefined) {
    const initial = totals
    enqueue(() => totalsTable.put(TOTALS_KEY, initial))
  }

  return {
    record (entry) {
      const row = { key: ledgerRecordKey(entry.ts), value: entry }
      rows.push(row)
      totals = addToTotals(totals, entry)
      const snapshot = totals
      // Writing the row and the counters as one queued unit keeps them from
      // drifting: both land, or both count as one failure. Each snapshot is the
      // full accumulated value, so a lost counters write is not permanent — the
      // next judgment's snapshot already includes what the lost one carried.
      enqueue(async () => {
        await judgments.put(row.key, entry)
        await totalsTable.put(TOTALS_KEY, snapshot)
      })
      const overflow = rows.length - maxRecords
      if (overflow > 0) {
        const dropped = rows.splice(0, overflow)
        enqueue(async () => {
          for (const old of dropped) await judgments.delete(old.key)
        })
      }
    },
    entries () {
      return rows.map(row => row.value)
    },
    get size () {
      return rows.length
    },
    summary () {
      return summarize(rows.map(row => row.value), totals)
    },
    get store () {
      return { kind: 'domain' as const, failures }
    },
  }
}
