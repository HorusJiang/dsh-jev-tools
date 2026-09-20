/**
 * The judgment ledger.
 *
 * This is the only place that knows what actually happened, and it exists for
 * three jobs that nothing else can do:
 *
 *   1. **Proving the increment.** DSH already prunes deterministically
 *      (`toolResultPruner` cuts a contiguous head/middle/tail), and S0 measured
 *      that the gross opportunity is about 32% of tool-result tokens. But the
 *      *net* gain over that existing baseline was never measurable from
 *      history. Recording both what the deterministic pruner would have kept
 *      and what semantic selection actually kept makes the increment a number
 *      from the first session rather than an argument.
 *   2. **Version traceability.** Aliases move between releases, so the model
 *      that actually answered is recorded per judgment rather than assumed.
 *   3. **Diagnosis.** Why a judgment did not happen is the question "the plugin
 *      appears to do nothing" always really asks, and only the skip records
 *      can answer it.
 *
 * A fourth job is deliberately *not* served here yet: **calibration**. The
 * reliability curve needs a probability and a later observable outcome per
 * judgment, and v0.1 has neither — a `noul` answer carries no confidence at
 * all, and nothing in the harness reports whether keeping a segment turned out
 * to be right. So the ledger stores the outcome-side bookkeeping only, and
 * `scripts/measure.ts` fits curves over a labelled set the user supplies.
 * Adding fabricated `p`/`y` fields here would make the gate look decidable
 * when it is not.
 *
 * Writes are best-effort by contract: a ledger failure must never fail a tool
 * call or a step.
 *
 * @module dsh-jev-tools/ledger
 */

import type { SkipReason } from './degrade.js'

/** Which capability produced a record. */
export type LedgerFeature = 'prune' | 'suggest' | 'screen' | 'tool' | 'command'

/** One judgment, successful or declined. */
export interface JudgmentRecord {
  readonly ts: number
  readonly agentId: string
  readonly feature: LedgerFeature
  readonly backendId: string
  /** The version that answered; empty when nothing was asked. */
  readonly model: string
  /** The alias or id that was requested, when a request went out. */
  readonly requestedModel?: string
  readonly latencyMs: number
  readonly inputTokens?: number
  readonly outcome: 'judged' | 'skipped'
  readonly skip?: SkipReason

  // ── prune measurements ────────────────────────────────────────────────────
  /** Estimated tokens of the payload as it arrived. */
  readonly originalTokens?: number
  /** What the deterministic pruner alone would have kept, when it would act. */
  readonly baselineKeptTokens?: number
  /** What semantic selection actually kept. */
  readonly keptTokens?: number
  readonly segments?: number
  readonly segmentsKept?: number
}

/**
 * Monotonic counters over every judgment ever recorded.
 *
 * These are kept separately from the records because retention is bounded:
 * once old records are evicted, a summary recomputed from the survivors would
 * shrink, and "how much has this plugin saved me" must not go *down* because
 * the plugin has been running for a long time.
 */
export interface LedgerTotals {
  readonly records: number
  readonly judged: number
  readonly skipped: number
  /** Tokens removed by this plugin. */
  readonly savedTokens: number
  /** Tokens the deterministic pruner would have removed on the same inputs. */
  readonly baselineSavedTokens: number
  /**
   * The increment: what semantic selection removed beyond the existing
   * deterministic baseline. Negative means the plugin kept *more* than the
   * baseline would have — which is the correct outcome when the baseline was
   * about to cut something relevant.
   */
  readonly netTokens: number
}

/** Aggregate view over the retained records plus the cumulative counters. */
export interface LedgerSummary extends LedgerTotals {
  /** Records still held in memory. May be less than `records` once evicted. */
  readonly retained: number
  readonly models: Readonly<Record<string, number>>
}

/** Where records actually live, for diagnosis. */
export interface LedgerStore {
  /** `domain` when records are persisted through `storageDomain`. */
  readonly kind: 'memory' | 'domain'
  /** Durable-write failures since mount. Writes are best-effort, so this is a hint, not an error. */
  readonly failures: number
}

/** A bounded, append-only record store. */
export interface Ledger {
  /** Append one record. Never throws. */
  record (entry: JudgmentRecord): void
  /** Retained records, oldest first. */
  entries (): readonly JudgmentRecord[]
  /** Records currently retained in memory; the cumulative count is `summary().records`. */
  readonly size: number
  /** Aggregate view over retained records and cumulative counters. */
  summary (): LedgerSummary
  /** Where the records live. */
  readonly store: LedgerStore
}

/** The zero value of {@link LedgerTotals}. */
export const EMPTY_TOTALS: LedgerTotals = {
  records: 0, judged: 0, skipped: 0, savedTokens: 0, baselineSavedTokens: 0, netTokens: 0,
}

/** Does this record contribute to the prune A/B measurement? */
function measuresPrune (entry: JudgmentRecord): boolean {
  return entry.feature === 'prune' && entry.outcome === 'judged'
}

/**
 * Fold one record into the counters.
 *
 * @param totals - the counters before this record.
 * @param entry - the record to fold in.
 * @returns the updated counters (never mutated in place).
 */
export function addToTotals (totals: LedgerTotals, entry: JudgmentRecord): LedgerTotals {
  const judged = entry.outcome === 'judged'
  let { savedTokens, baselineSavedTokens, netTokens } = totals
  if (measuresPrune(entry)) {
    const original = entry.originalTokens ?? 0
    const kept = entry.keptTokens ?? 0
    // An absent baseline means the deterministic pruner was not there to
    // measure (no `toolResultPruner` service, or it declined), so it would have
    // removed nothing and the whole saving is this plugin's. That reading also
    // keeps `saved === baselineSaved + net` exact instead of leaving a residual
    // that no number in the report accounts for.
    const baselineKept = entry.baselineKeptTokens ?? original
    savedTokens += original - kept
    baselineSavedTokens += original - baselineKept
    netTokens += baselineKept - kept
  }
  return {
    records: totals.records + 1,
    judged: totals.judged + (judged ? 1 : 0),
    skipped: totals.skipped + (judged ? 0 : 1),
    savedTokens,
    baselineSavedTokens,
    netTokens,
  }
}

/** Fold a whole record list into fresh counters. */
export function totalsOf (records: readonly JudgmentRecord[]): LedgerTotals {
  let totals = EMPTY_TOTALS
  for (const record of records) totals = addToTotals(totals, record)
  return totals
}

/** Count how many records each answering version produced. */
export function countModels (records: readonly JudgmentRecord[]): Record<string, number> {
  const models: Record<string, number> = {}
  for (const record of records) {
    if (record.model === '') continue
    models[record.model] = (models[record.model] ?? 0) + 1
  }
  return models
}

/**
 * Combine retained records with cumulative counters.
 *
 * Both ledger implementations go through here, so the two can never disagree
 * about what a summary means.
 *
 * @param records - the retained records, used for the version histogram.
 * @param totals - the cumulative counters.
 * @returns the aggregate view.
 */
export function summarize (records: readonly JudgmentRecord[], totals: LedgerTotals): LedgerSummary {
  return { ...totals, retained: records.length, models: countModels(records) }
}

/** The store description of a purely in-memory ledger. */
const MEMORY_STORE: LedgerStore = { kind: 'memory', failures: 0 }

/**
 * Create an in-memory ledger.
 *
 * This is the fallback whenever the storage domain is absent or fails to open,
 * and the implementation the tests drive. Retention is bounded because the host
 * is long-lived and every session creates an agent.
 *
 * @param maxRecords - ceiling on retained records; the oldest is dropped.
 * @returns the ledger.
 */
export function createMemoryLedger (maxRecords = 2_000): Ledger {
  let records: JudgmentRecord[] = []

  return {
    record (entry) {
      records.push(entry)
      if (records.length > maxRecords) records = records.slice(records.length - maxRecords)
    },
    entries () {
      return records
    },
    get size () {
      return records.length
    },
    summary () {
      return summarize(records, totalsOf(records))
    },
    get store () {
      return MEMORY_STORE
    },
  }
}

/**
 * Create a ledger that can be switched off at runtime.
 *
 * `ledger.enabled` is a user-facing switch, so it has to actually *do*
 * something. Reads pass through — a user who turns recording off can still see
 * what was recorded before — but new records are dropped.
 *
 * The check is a live predicate rather than a captured boolean: settings can
 * change mid-session, and a switch that only takes effect after a restart is
 * the same lie in a slower form.
 *
 * @param inner - the ledger that does the work.
 * @param isEnabled - read on every write.
 * @returns the gated ledger.
 */
export function createGatedLedger (inner: Ledger, isEnabled: () => boolean): Ledger {
  return {
    record (entry) {
      if (isEnabled()) inner.record(entry)
    },
    entries () {
      return inner.entries()
    },
    get size () {
      return inner.size
    },
    summary () {
      return inner.summary()
    },
    get store () {
      return inner.store
    },
  }
}

/** A ledger handle plus the one-way switch to its durable implementation. */
export interface LazyLedger {
  /** The handle every caller holds. It outlives the swap. */
  readonly ledger: Ledger
  /**
   * Hand over the durable ledger.
   *
   * Everything recorded while the domain was still opening is replayed into it
   * first, in order, so the async open window costs no record. Idempotent: a
   * second call is ignored, which keeps a duplicate `open` from double-counting.
   *
   * @param next - the durable ledger that takes over.
   */
  attach (next: Ledger): void
}

/**
 * Create a ledger that starts in memory and can be upgraded in place.
 *
 * Opening a storage domain is asynchronous, but `record()` is synchronous and
 * judgements start as soon as the plugin mounts. Rather than make every caller
 * read through a `() => Ledger` getter, this hands out one stable handle and
 * absorbs the swap — including replaying whatever the buffer already holds.
 *
 * @returns the handle and its attach switch.
 */
export function createLazyLedger (): LazyLedger {
  const buffer = createMemoryLedger()
  let active: Ledger = buffer
  let attached = false

  const view: Ledger = {
    record (entry) {
      active.record(entry)
    },
    entries () {
      return active.entries()
    },
    get size () {
      return active.size
    },
    summary () {
      return active.summary()
    },
    get store () {
      return active.store
    },
  }

  return {
    ledger: view,
    attach (next) {
      if (attached) return
      attached = true
      // Safe to iterate the buffer's live array: `record` is synchronous, so
      // nothing can append while the replay runs.
      for (const entry of buffer.entries()) next.record(entry)
      active = next
    },
  }
}
