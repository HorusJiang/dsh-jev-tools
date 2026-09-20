/**
 * Reproducible measurement over what actually happened.
 *
 * Two different questions, and they need different data:
 *
 *   - **Calibration** — over a labelled set (`{p, y}` JSONL): is a probability
 *     from this model usable as a *gate*? This needs truth labels, so it can
 *     only ever come from data a user supplies. It reports the calibration
 *     error both before and after fitting, because the gap between those two is
 *     the whole question.
 *   - **Increment** — over the plugin's own ledger: how many tokens did semantic
 *     pruning remove *beyond* the deterministic baseline DSH already applies?
 *     No labels are needed, because the baseline is measured per judgment. This
 *     is what makes the plugin's value a number from the first session instead
 *     of an argument.
 *
 * Neither substitutes for the other, so the report says which one it is
 * reporting and why the other is out of reach for that input. In particular the
 * ledger holds **no probability and no later outcome** — a `noul` answer carries
 * no confidence at all, and nothing in the harness reports whether a pruned
 * segment turned out to be needed — so the ledger cannot produce an accuracy
 * figure, and this script does not invent one.
 *
 * Usage:
 *   node scripts/measure.ts samples.jsonl          labelled calibration data
 *   node scripts/measure.ts --ledger               the live ledger, from the storage domain
 *   node scripts/measure.ts --ledger --root <dir>  a different storage root
 *   node scripts/measure.ts --json report.json     also write the report as JSON
 *   node scripts/measure.ts --jsonl records.jsonl  also write the normalised records
 *   node scripts/measure.ts                        the built-in smoke set
 *
 * `--ledger` reads the per-record documents the plugin wrote. That needs
 * `npm run build` once, because the reader shares the writer's constants
 * (`src/ledger-domain.ts`) so the on-disk format cannot drift between the two.
 *
 * @module scripts/measure
 */

import fs from 'node:fs'
import { apply, expectedCalibrationError, fit, fitPlatt, fitIsotonic, type Sample } from '../src/calibrate.ts'
import { defaultStorageRoot, ledgerDomainDir, readLedgerRecords, type LedgerGaps, type LedgerTotals } from './lib/ledger-files.ts'
import type { JudgmentRecord } from '../lib/ledger.js'

/** One labelled judgment, plus whatever context was recorded with it. */
interface LabelledRecord {
  readonly p: number
  readonly y: 0 | 1
  readonly model?: string
  readonly latencyMs?: number
  readonly inputTokens?: number
}

/** Input price: $0.042 per million tokens, output free. */
const USD_PER_MTOK = 0.042

// ── argument parsing ────────────────────────────────────────────────────────

const argv = process.argv.slice(2)

/** Value of `--flag`, when the next argument is not itself a flag. */
function flagValue (name: string): string | undefined {
  const at = argv.indexOf(name)
  if (at < 0) return undefined
  const value = argv[at + 1]
  return value === undefined || value.startsWith('--') ? undefined : value
}

const rootArg = flagValue('--root')
const jsonOut = flagValue('--json')
const jsonlOut = flagValue('--jsonl')
const positional = argv.find(arg => !arg.startsWith('--') && arg !== rootArg && arg !== jsonOut && arg !== jsonlOut)
const ledgerMode = argv.includes('--ledger') || rootArg !== undefined
  || (positional !== undefined && fs.existsSync(positional) && fs.statSync(positional).isDirectory())

/** Where the durable ledger lives when `--root` is not given. */
const storageRoot = rootArg ?? defaultStorageRoot()

// ── statistics ──────────────────────────────────────────────────────────────

/** Percentile of a sorted array. */
function percentile (sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))))]!
}

/** Brier score: mean squared error of the probability. */
function brier (samples: readonly Sample[]): number {
  if (samples.length === 0) return 0
  return samples.reduce((sum, s) => sum + (s.p - s.y) ** 2, 0) / samples.length
}

/** Accuracy when every p above the threshold is called positive. */
function accuracy (samples: readonly Sample[], threshold = 0.5): number {
  if (samples.length === 0) return 0
  const correct = samples.filter(s => (s.p >= threshold ? 1 : 0) === s.y).length
  return correct / samples.length
}

/** A ten-bin reliability table, printed so the shape is visible, not just the summary. */
function reliability (samples: readonly Sample[]): string[] {
  const lines: string[] = []
  const bins = 10
  for (let bin = 0; bin < bins; bin += 1) {
    const low = bin / bins
    const high = (bin + 1) / bins
    const inBin = samples.filter(s => s.p >= low && (bin === bins - 1 ? s.p <= high : s.p < high))
    if (inBin.length === 0) continue
    const predicted = inBin.reduce((sum, s) => sum + s.p, 0) / inBin.length
    const observed = inBin.reduce((sum, s) => sum + s.y, 0) / inBin.length
    const bar = '#'.repeat(Math.round(observed * 20))
    lines.push(
      `  ${low.toFixed(1)}–${high.toFixed(1)}  n=${String(inBin.length).padStart(4)}`
      + `  predicted ${predicted.toFixed(3)}  observed ${observed.toFixed(3)}  ${bar}`
    )
  }
  return lines
}

/** Print a key/count table, largest first. */
function histogram (counts: Map<string, number>, indent = '  '): string[] {
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => `${indent}${key} × ${count}`)
}

/** The eight-item Chinese routing set used during development. */
const SMOKE_SAMPLES: LabelledRecord[] = [
  { p: 1.000, y: 1, model: 'jev-1.13.0', latencyMs: 340, inputTokens: 1463 },
  { p: 1.000, y: 1, model: 'jev-1.13.0', latencyMs: 340, inputTokens: 0 },
  { p: 1.000, y: 1, model: 'jev-1.13.0', latencyMs: 340, inputTokens: 0 },
  { p: 1.000, y: 1, model: 'jev-1.13.0', latencyMs: 340, inputTokens: 0 },
  { p: 1.000, y: 1, model: 'jev-1.13.0', latencyMs: 340, inputTokens: 0 },
  { p: 1.000, y: 1, model: 'jev-1.13.0', latencyMs: 340, inputTokens: 0 },
  { p: 1.000, y: 1, model: 'jev-1.13.0', latencyMs: 340, inputTokens: 0 },
  { p: 0.990, y: 1, model: 'jev-1.13.0', latencyMs: 340, inputTokens: 0 },
]

// ── input ───────────────────────────────────────────────────────────────────

/** Parse a JSONL file into raw objects. */
function readJsonl (file: string): Record<string, unknown>[] {
  const text = fs.readFileSync(file, 'utf8')
  const records: Record<string, unknown>[] = []
  for (const [index, line] of text.split('\n').entries()) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('not a JSON object')
      }
      records.push(parsed as Record<string, unknown>)
    } catch (error) {
      throw new Error(`line ${index + 1} is not valid JSON: ${String(error)}`)
    }
  }
  return records
}

// ── report: calibration ─────────────────────────────────────────────────────

/** Report over a labelled set. */
function reportCalibration (records: LabelledRecord[], source: string): Record<string, unknown> {
  const samples: Sample[] = records.map(r => ({ p: r.p, y: r.y }))
  const report: Record<string, unknown> = { mode: 'calibration', samples: records.length }

  console.log(`\nJev calibration — ${records.length} labelled judgments from ${source}`)
  console.log('  (a labelled set is the only input that can answer this: the ledger holds no probability and no outcome)')

  const rawEce = expectedCalibrationError(samples)
  const rawBrier = brier(samples)
  console.log('\n--- raw scores ---')
  console.log(`  accuracy @0.5 : ${(accuracy(samples) * 100).toFixed(1)}%`)
  console.log(`  mean p        : ${(samples.reduce((sum, s) => sum + s.p, 0) / samples.length).toFixed(3)}`)
  console.log(`  observed rate : ${(samples.reduce((sum, s) => sum + s.y, 0) / samples.length).toFixed(3)}`)
  console.log(`  ECE           : ${rawEce.toFixed(4)}`)
  console.log(`  Brier         : ${rawBrier.toFixed(4)}`)
  report.raw = { accuracy: accuracy(samples), ece: rawEce, brier: rawBrier }

  console.log('\n--- reliability (predicted vs observed, by bin) ---')
  for (const line of reliability(samples)) console.log(line)

  // Reported as in-sample, which is optimistic; the gap still shows the
  // direction and rough size of the correction.
  const model = records[0]?.model ?? 'unknown'
  if (samples.length >= 5) {
    const params = fit(samples, model, () => 0)
    const recalibrated: Sample[] = samples.map(s => ({ p: apply(params, s.p, model).p, y: s.y }))
    const fittedEce = expectedCalibrationError(recalibrated)
    console.log(`\n--- after an in-sample ${params.method} fit on ${params.samples} samples ---`)
    console.log(`  ECE    : ${rawEce.toFixed(4)} → ${fittedEce.toFixed(4)}`)
    console.log(`  Brier  : ${rawBrier.toFixed(4)} → ${brier(recalibrated).toFixed(4)}`)
    console.log('  (in-sample, so optimistic — fit on a held-out split before trusting it)')
    report.calibrated = { method: params.method, ece: fittedEce, brier: brier(recalibrated) }
    // A fit that flattens everything would destroy the ranking pruning relies on.
    report.notes = {
      isotonicKnots: fitIsotonic(samples).length,
      platt: params.method === 'platt' ? fitPlatt(samples) : undefined,
    }
  }

  const latencies = records.map(r => r.latencyMs).filter((v): v is number => typeof v === 'number').sort((a, b) => a - b)
  if (latencies.length > 0) {
    console.log('\n--- latency ---')
    console.log(`  p50 ${percentile(latencies, 0.5)}ms  p90 ${percentile(latencies, 0.9)}ms  max ${latencies.at(-1)}ms`)
    report.latency = { p50: percentile(latencies, 0.5), p90: percentile(latencies, 0.9), max: latencies.at(-1) }
  }
  const tokens = records.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0)
  if (tokens > 0) {
    const cost = (tokens / 1_000_000) * USD_PER_MTOK
    console.log('\n--- cost (input only; output is free) ---')
    console.log(`  ${tokens} input tokens total → $${cost.toFixed(6)}`)
    console.log(`  $${((cost / records.length) * 1_000).toFixed(4)} per 1,000 judgments`)
    report.cost = { inputTokens: tokens, usd: cost }
  }

  const versions = new Map<string, number>()
  for (const record of records) {
    if (record.model === undefined) continue
    versions.set(record.model, (versions.get(record.model) ?? 0) + 1)
  }
  if (versions.size > 0) {
    console.log('\n--- answering versions ---')
    for (const [version, count] of versions) console.log(`  ${version} × ${count}`)
    console.log('  Recorded per judgment because aliases move between releases.')
    report.versions = Object.fromEntries(versions)
  }
  return report
}

// ── report: increment ───────────────────────────────────────────────────────

/** Report over the plugin's own ledger. */
function reportLedger (
  records: JudgmentRecord[],
  gaps: LedgerGaps,
  totals: LedgerTotals | undefined,
  source: string
): Record<string, unknown> {
  const report: Record<string, unknown> = { mode: 'increment', records: records.length }

  console.log(`\nJev increment — ${records.length} ledger records from ${source}`)
  console.log('  (the ledger holds no probability and no later outcome, so it cannot report accuracy.)')
  console.log('  (for accuracy, label a set as {"p": ..., "y": 0|1} JSONL and measure that instead.)')

  if (gaps.unreadable + gaps.foreignVersion + gaps.invalidRecord > 0) {
    console.log('\n--- documents skipped ---')
    console.log(`  unparseable ${gaps.unreadable}  foreign version ${gaps.foreignVersion}  failed schema ${gaps.invalidRecord}`)
    console.log('  (a version-stamped or schema-invalid document is discarded by design, not migrated)')
    report.gaps = gaps
  }

  const judged = records.filter(entry => entry.outcome === 'judged')
  const skipped = records.filter(entry => entry.outcome === 'skipped')
  const prunes = judged.filter(entry => entry.feature === 'prune')

  console.log('\n--- judgments ---')
  console.log(`  records ${records.length}  judged ${judged.length}  skipped ${skipped.length}`)
  report.counts = { records: records.length, judged: judged.length, skipped: skipped.length }

  // The increment: what semantic selection removed beyond the deterministic
  // baseline DSH already applies. An absent baseline means the deterministic
  // pruner was not there to measure, so it would have removed nothing.
  let original = 0
  let kept = 0
  let baselineKept = 0
  let segments = 0
  let segmentsKept = 0
  for (const entry of prunes) {
    original += entry.originalTokens ?? 0
    kept += entry.keptTokens ?? 0
    baselineKept += entry.baselineKeptTokens ?? entry.originalTokens ?? 0
    segments += entry.segments ?? 0
    segmentsKept += entry.segmentsKept ?? 0
  }
  if (prunes.length > 0) {
    const saved = original - kept
    const baselineSaved = original - baselineKept
    const net = baselineKept - kept
    const pct = (value: number): string => (original === 0 ? '—' : `${(value / original * 100).toFixed(1)}%`)
    console.log(`\n--- tokens, over ${prunes.length} pruned payloads ---`)
    console.log(`  arrived                 ${original}`)
    console.log(`  this plugin kept        ${kept}   (removed ${saved}, ${pct(saved)})`)
    console.log(`  DSH baseline kept       ${baselineKept}   (would have removed ${baselineSaved}, ${pct(baselineSaved)})`)
    console.log(`  increment over baseline ${net}   ${pct(net)}`)
    if (segments > 0) console.log(`  segments kept           ${segmentsKept}/${segments}`)
    console.log('  The increment is what semantic selection removed that the built-in')
    console.log('  contiguous head/middle/tail cut would have left in the context.')
    report.tokens = { original, kept, saved, baselineKept, baselineSaved, net, segments, segmentsKept }
  }

  if (totals !== undefined) {
    console.log('\n--- counters on the medium (cumulative across runs) ---')
    console.log(`  records ${totals.records}  judged ${totals.judged}  skipped ${totals.skipped}`)
    console.log(`  removed ${totals.savedTokens}  baseline would have removed ${totals.baselineSavedTokens}  increment ${totals.netTokens}`)
    if (totals.records !== records.length) {
      console.log(`  (${totals.records - records.length} records were evicted by bounded retention,`)
      console.log('   which is why the cumulative counters are stored separately)')
    }
    report.totals = totals
  }

  if (skipped.length > 0) {
    const reasons = new Map<string, number>()
    for (const entry of skipped) {
      const reason = entry.skip ?? '—'
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
    }
    console.log('\n--- why judgments did not happen ---')
    for (const line of histogram(reasons)) console.log(line)
    report.skipReasons = Object.fromEntries(reasons)
  }

  // Shadow-mode records are `skipped`, so the totals above exclude them by
  // construction — nothing was actually removed. But "what it would have
  // removed" is the entire reason to run in shadow mode, so dropping it here
  // would make the mode look like it did nothing at all.
  const shadow = records.filter(entry => entry.skip === 'shadow')
  if (shadow.length > 0) {
    let wouldRemove = 0
    let wouldKeep = 0
    for (const entry of shadow) {
      wouldRemove += (entry.originalTokens ?? 0) - (entry.keptTokens ?? 0)
      wouldKeep += entry.keptTokens ?? 0
    }
    console.log('\n--- shadow mode: judged but not applied ---')
    console.log(`  ${shadow.length} payloads would have been pruned`)
    console.log(`  would have removed ${wouldRemove} tokens (leaving ${wouldKeep})`)
    console.log('  Nothing above is counted in the totals, because nothing was removed.')
    report.shadow = { payloads: shadow.length, wouldRemove, wouldKeep }
  }

  const features = new Map<string, number>()
  for (const entry of records) features.set(entry.feature, (features.get(entry.feature) ?? 0) + 1)
  console.log('\n--- by capability ---')
  for (const line of histogram(features)) console.log(line)

  const latencies = records.map(entry => entry.latencyMs)
    .filter(value => typeof value === 'number' && value > 0).sort((a, b) => a - b)
  if (latencies.length > 0) {
    console.log('\n--- latency ---')
    console.log(`  p50 ${percentile(latencies, 0.5)}ms  p90 ${percentile(latencies, 0.9)}ms  max ${latencies.at(-1)}ms`)
    report.latency = { p50: percentile(latencies, 0.5), p90: percentile(latencies, 0.9), max: latencies.at(-1) }
  }

  const tokens = records.reduce((sum, entry) => sum + (entry.inputTokens ?? 0), 0)
  if (tokens > 0) {
    const cost = (tokens / 1_000_000) * USD_PER_MTOK
    console.log('\n--- cost (input only; output is free) ---')
    console.log(`  ${tokens} input tokens total → $${cost.toFixed(6)}`)
    report.cost = { inputTokens: tokens, usd: cost }
  }

  const versions = new Map<string, number>()
  for (const entry of records) {
    if (entry.model === '') continue
    versions.set(entry.model, (versions.get(entry.model) ?? 0) + 1)
  }
  if (versions.size > 0) {
    console.log('\n--- answering versions ---')
    for (const [version, count] of versions) console.log(`  ${version} × ${count}`)
    console.log('  Recorded per judgment because aliases move between releases.')
    report.versions = Object.fromEntries(versions)
  }
  return report
}

// ── dispatch ────────────────────────────────────────────────────────────────

let report: Record<string, unknown>
/** Records normalised out of whatever the input was, for `--jsonl`. */
let normalised: Record<string, unknown>[] = []

if (ledgerMode) {
  // A directory argument is a domain directory; otherwise it is the storage root.
  const domainDir = positional !== undefined && fs.statSync(positional).isDirectory()
    ? positional
    : ledgerDomainDir(storageRoot)
  let snapshot
  try {
    snapshot = readLedgerRecords(domainDir)
  } catch (error) {
    // "There is nothing to read yet" is the most likely first invocation, so it
    // gets the message the reader wrote rather than a stack trace.
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
  const { records, gaps, totals } = snapshot
  normalised = records as unknown as Record<string, unknown>[]
  if (records.length === 0 && totals === undefined) {
    console.error(`the ledger at ${domainDir} holds nothing yet — nothing to measure`)
    process.exit(1)
  }
  report = reportLedger(records, gaps, totals, domainDir)
} else {
  const source = positional ?? '(built-in smoke set)'
  const raw: Record<string, unknown>[] = positional === undefined
    ? SMOKE_SAMPLES as unknown as Record<string, unknown>[]
    : readJsonl(positional)
  // A ledger export pasted into a file is a legitimate input; detect it rather
  // than failing on a missing `p`, which would make the two halves look like
  // one half with a broken input format.
  const looksLikeLedger = raw.length > 0 && raw[0] !== undefined
    && 'feature' in raw[0] && 'outcome' in raw[0]
  if (looksLikeLedger) {
    normalised = raw
    report = reportLedger(raw as unknown as JudgmentRecord[], { unreadable: 0, foreignVersion: 0, invalidRecord: 0 }, undefined, source)
  } else {
    for (const [index, entry] of raw.entries()) {
      if (typeof entry['p'] !== 'number' || (entry['y'] !== 0 && entry['y'] !== 1)) {
        console.error(`line ${index + 1} needs "p" (number) and "y" (0 or 1), or ledger fields (feature, outcome)`)
        process.exit(1)
      }
    }
    normalised = raw
    report = reportCalibration(raw as unknown as LabelledRecord[], source)
  }
}

if (jsonlOut !== undefined) {
  fs.writeFileSync(jsonlOut, normalised.map(entry => JSON.stringify(entry)).join('\n') + (normalised.length > 0 ? '\n' : ''))
  console.log(`\nwrote ${normalised.length} records to ${jsonlOut}`)
}

if (jsonOut !== undefined) {
  fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2))
  console.log(`\nwrote ${jsonOut}`)
}

console.log('')
