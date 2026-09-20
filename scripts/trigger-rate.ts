/**
 * S0 — trigger-rate measurement.
 *
 * Decides the v0.1 thresholds by measuring them on real sessions instead of
 * guessing. The load-bearing number is `触发率 × 单次延迟 = 每 turn 增量`: the
 * pruning hook (`tools/post-execute`) is an awaited waterfall on every tool
 * call, so what matters is not one call's latency but how many calls per turn
 * would actually fire.
 *
 * Measured:
 *   1. tool-result size distribution and the share above candidate thresholds
 *   2. read-family vs other tools among oversized results (allowlist sizing)
 *   3. would-be triggers per turn at each candidate threshold (quota sizing)
 *   4. projected added seconds per turn and worst single turn
 *   5. turns that touched files (input for the v0.3 turn-stopping gate)
 *   6. skill-catalog size as delivered to the model
 *
 * Token counts are an ESTIMATE (~±20%): `cjkChars + otherChars / 4`. They are
 * used for ratio and shape, not for billing.
 *
 * Usage: node scripts/trigger-rate.ts [--json out.json]
 *
 * @module scripts/trigger-rate
 */

import fs from 'node:fs'
import { findSessionLogs, readSessionLog, type SessionRecord } from './lib/session-log.ts'

/** Read-family tools whose bulk output is worth judging for relevance. */
const READ_FAMILY = new Set(['read', 'grep', 'glob', 'web_fetch', 'web_search'])

/** Candidate size thresholds, in estimated tokens. */
const CANDIDATE_THRESHOLDS = [1000, 1500, 2000, 3000, 6000]

/** Candidate per-turn caps. */
const CANDIDATE_CAPS = [1, 2, 3, 5]

/** Assumed per-judgment latency for the projection, in milliseconds. */
const ASSUMED_LATENCY_MS = 300

/** A measured tool result. */
interface ResultSample {
  readonly session: string
  readonly turn: number
  readonly tool: string
  readonly tokens: number
  readonly isError: boolean
}

/** Estimate tokens from text: CJK counts ~1, other characters ~1/4. */
function estimateTokens (text: string): number {
  let cjk = 0
  let other = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) cjk += 1
    else other += 1
  }
  return cjk + other / 4
}

/** Extract every text block from a `tool/result` payload. */
function resultText (record: SessionRecord): { text: string, isError: boolean } {
  const data = record.data as { message?: { content?: { content?: unknown[] }[] } } | undefined
  let text = ''
  let isError = false
  for (const outer of data?.message?.content ?? []) {
    for (const block of outer.content ?? []) {
      const typed = block as { type?: string, text?: string, isError?: boolean }
      if (typed.type === 'text' && typeof typed.text === 'string') text += typed.text
      if (typed.isError === true) isError = true
    }
  }
  return { text, isError }
}

/** Visit every string nested anywhere in a value. */
function walkStrings (value: unknown, visit: (text: string) => void): void {
  if (typeof value === 'string') { visit(value); return }
  if (Array.isArray(value)) { for (const item of value) walkStrings(item, visit); return }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) walkStrings(item, visit)
  }
}

/** Count skill entries in a delivered `<available_skills>` block, or 0. */
function skillCountIn (text: string): number {
  const open = text.indexOf('<available_skills>')
  if (open < 0) return 0
  const close = text.indexOf('</available_skills>')
  const block = close > open ? text.slice(open, close) : text.slice(open)
  return (block.match(/^- `/gm) ?? []).length
}

/** Percentile of a sorted numeric array. */
function percentile (sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))))
  return sorted[index]!
}

/** Mean, rounded. */
function mean (values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

const logs = findSessionLogs(process.env.DSH_HOME ?? `${process.env.USERPROFILE}\\.dsh`)
const results: ResultSample[] = []
const turnsWithFiles = new Set<string>()
const allTurns = new Set<string>()
const skillCounts: number[] = []
let recordsSeen = 0

for (const file of logs) {
  let log
  try {
    log = readSessionLog(file)
  } catch {
    continue
  }
  const session = log.header?.id ?? file
  recordsSeen += log.records.length
  const callNames = new Map<string, string>()

  for (const record of log.records) {
    const data = record.data as { turn?: number, callId?: string, name?: string } | undefined

    if (record.type === 'tool/call') {
      if (data?.callId !== undefined && data.name !== undefined) callNames.set(data.callId, data.name)
      continue
    }
    if (record.type === 'turn/start' && data?.turn !== undefined) {
      allTurns.add(`${session}#${data.turn}`)
      continue
    }
    if (record.type === 'workspace/changes' && data?.turn !== undefined) {
      turnsWithFiles.add(`${session}#${data.turn}`)
      continue
    }
    if (record.type === 'tool/result') {
      const outer = (record.data as { message?: { content?: { toolCallId?: string }[] } } | undefined)?.message?.content?.[0]
      const tool = outer?.toolCallId !== undefined ? callNames.get(outer.toolCallId) ?? '<unknown>' : '<unknown>'
      const { text, isError } = resultText(record)
      results.push({ session, turn: data?.turn ?? -1, tool, tokens: estimateTokens(text), isError })
      continue
    }
    // The skill catalog arrives as a delivered context block, historically on a
    // user message rather than in the system section.
    if (record.type === 'user/message' || record.type === 'system/message') {
      walkStrings(record.data, (text) => {
        const count = skillCountIn(text)
        if (count > 0) skillCounts.push(count)
      })
    }
  }
}

const report: Record<string, unknown> = {}
console.log(`\nS0 trigger-rate report — ${logs.length} logs, ${recordsSeen} records, ${results.length} tool results\n`)

// ---- 1. size distribution -------------------------------------------------
const sizes = results.map(r => r.tokens).sort((a, b) => a - b)
console.log('--- 1. tool-result size (estimated tokens) ---')
console.log(`  mean ${mean(sizes).toFixed(0)}  p50 ${percentile(sizes, 0.5).toFixed(0)}  p90 ${percentile(sizes, 0.9).toFixed(0)}  p99 ${percentile(sizes, 0.99).toFixed(0)}  max ${Math.max(0, ...sizes).toFixed(0)}`)
const overShare: Record<string, number> = {}
for (const threshold of CANDIDATE_THRESHOLDS) {
  const over = results.filter(r => r.tokens > threshold)
  overShare[String(threshold)] = over.length / Math.max(1, results.length)
  console.log(`  > ${String(threshold).padStart(6)} tok : ${String(over.length).padStart(5)} (${(overShare[String(threshold)]! * 100).toFixed(1)}%)`)
}
report.sizeDistribution = {
  count: results.length, mean: mean(sizes), p50: percentile(sizes, 0.5),
  p90: percentile(sizes, 0.9), p99: percentile(sizes, 0.99), overShare,
}

// ---- 2. read-family share among oversized ---------------------------------
console.log('\n--- 2. read-family share among oversized results (allowlist sizing) ---')
for (const threshold of [1500, 3000]) {
  const over = results.filter(r => r.tokens > threshold && !r.isError)
  const read = over.filter(r => READ_FAMILY.has(r.tool))
  console.log(`  > ${threshold} tok & not error: ${over.length};  read-family ${read.length} (${((read.length / Math.max(1, over.length)) * 100).toFixed(1)}%)`)
  const byTool = new Map<string, number>()
  for (const r of over) byTool.set(r.tool, (byTool.get(r.tool) ?? 0) + 1)
  console.log(`     by tool: ${[...byTool].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t, c]) => `${t} ${c}`).join(', ')}`)
}
const byToolAll = new Map<string, number>()
for (const r of results) byToolAll.set(r.tool, (byToolAll.get(r.tool) ?? 0) + 1)
report.byTool = Object.fromEntries([...byToolAll].sort((a, b) => b[1] - a[1]))

// ---- 3+4. per-turn triggers and projected latency, per threshold ----------
console.log('\n--- 3. would-be triggers per turn, by candidate minTokens ---')
console.log(`  (read-family, not error; total turns with a turn/start = ${allTurns.size})\n`)
console.log('  minTokens | trigTurns | mean/turn | p90 | max | cap3→mean | cap3→worst')
const perThreshold: Record<string, unknown> = {}
for (const threshold of CANDIDATE_THRESHOLDS) {
  const perTurn = new Map<string, number>()
  for (const r of results) {
    if (r.isError || r.tokens <= threshold || !READ_FAMILY.has(r.tool)) continue
    const key = `${r.session}#${r.turn}`
    perTurn.set(key, (perTurn.get(key) ?? 0) + 1)
  }
  const counts = [...perTurn.values()].sort((a, b) => a - b)
  const capped = counts.map(c => Math.min(c, 3))
  const cappedMean = mean(capped) * ASSUMED_LATENCY_MS / 1000
  const cappedWorst = 3 * ASSUMED_LATENCY_MS / 1000
  console.log(
    `  ${String(threshold).padStart(9)} | ${String(counts.length).padStart(9)} | ${mean(counts).toFixed(1).padStart(9)} | ${String(percentile(counts, 0.9)).padStart(3)} | ${String(counts.at(-1) ?? 0).padStart(3)} | ${cappedMean.toFixed(2).padStart(9)}s | ${cappedWorst.toFixed(1)}s`
  )
  perThreshold[String(threshold)] = {
    triggeringTurns: counts.length, mean: mean(counts), p90: percentile(counts, 0.9),
    max: counts.at(-1) ?? 0, cappedMeanSeconds: cappedMean,
  }
}
report.perTurnByThreshold = perThreshold
const anyCounts = [...(() => {
  const perTurn = new Map<string, number>()
  for (const r of results) {
    if (r.isError || r.tokens <= 1500 || !READ_FAMILY.has(r.tool)) continue
    const key = `${r.session}#${r.turn}`
    perTurn.set(key, (perTurn.get(key) ?? 0) + 1)
  }
  return perTurn.values()
})()].sort((a, b) => a - b)
console.log(`\n  share of triggering turns exceeding each cap (@1500):`)
for (const cap of CANDIDATE_CAPS) {
  const over = anyCounts.filter(c => c > cap).length
  console.log(`    cap ${cap}: ${over}/${anyCounts.length} (${((over / Math.max(1, anyCounts.length)) * 100).toFixed(1)}%)`)
}
report.projection = {
  assumedLatencyMs: ASSUMED_LATENCY_MS,
  uncappedWorstSeconds: (anyCounts.at(-1) ?? 0) * ASSUMED_LATENCY_MS / 1000,
}

// ---- 4b. projected context saved ------------------------------------------
// Latency turns out to be cap-dominated, so the threshold should be chosen on
// savings instead. This is a MODEL, not a measurement: it assumes pruning keeps
// the least-relevant 35% away (bounded below by `minKeepRatio` = 0.2).
const KEEP_SHARE = 0.35
const MIN_KEEP_SHARE = 0.2
console.log(`\n--- 4b. projected context saved (MODEL: keeps ${KEEP_SHARE * 100}% of a judged result) ---`)
const allTokens = results.reduce((sum, r) => sum + r.tokens, 0)
console.log(`  total tool-result tokens across all sessions: ${allTokens.toFixed(0)}`)
console.log('  minTokens | judged | tokens judged | tokens saved | % of all | saved/trigTurn')
for (const threshold of CANDIDATE_THRESHOLDS) {
  const judged = results.filter(r => !r.isError && r.tokens > threshold && READ_FAMILY.has(r.tool))
  const judgedTokens = judged.reduce((sum, r) => sum + r.tokens, 0)
  const savedTokens = judged.reduce((sum, r) => sum + r.tokens * (1 - Math.max(MIN_KEEP_SHARE, KEEP_SHARE)), 0)
  const turnCount = new Set(judged.map(r => `${r.session}#${r.turn}`)).size
  console.log(
    `  ${String(threshold).padStart(9)} | ${String(judged.length).padStart(6)} | ${judgedTokens.toFixed(0).padStart(13)} | ${savedTokens.toFixed(0).padStart(12)} | ${((savedTokens / Math.max(1, allTokens)) * 100).toFixed(1).padStart(7)}% | ${(savedTokens / Math.max(1, turnCount)).toFixed(0).padStart(14)}`
  )
  ;(report.savings ??= {})[String(threshold)] = {
    judged: judged.length, judgedTokens, savedTokens,
    shareOfAll: savedTokens / Math.max(1, allTokens), triggeringTurns: turnCount,
  }
}

// ---- 5. turns touching files ----------------------------------------------
console.log('\n--- 5. turns that touched files (input for the v0.3 turn-stopping gate) ---')
console.log(`  ${turnsWithFiles.size} of ${allTurns.size} turns (${((turnsWithFiles.size / Math.max(1, allTurns.size)) * 100).toFixed(1)}%)`)
report.turnsWithFiles = { withFiles: turnsWithFiles.size, total: allTurns.size }

// ---- 6. skill catalog size ------------------------------------------------
console.log('\n--- 6. skill-catalog size as delivered to the model ---')
const sortedSkills = [...skillCounts].sort((a, b) => a - b)
if (sortedSkills.length > 0) {
  const pct = (f: number) => percentile(sortedSkills, f)
  console.log(`  n=${sortedSkills.length}  min ${sortedSkills[0]}  p50 ${pct(0.5)}  p90 ${pct(0.9)}  max ${sortedSkills.at(-1)}`)
  for (const threshold of [5, 10, 15, 20]) {
    const share = sortedSkills.filter(c => c >= threshold).length / sortedSkills.length
    console.log(`    catalogs with >= ${String(threshold).padStart(2)} skills: ${(share * 100).toFixed(0)}%`)
  }
} else {
  console.log('  no skill block found')
}
report.skillCatalog = {
  samples: sortedSkills.length, min: sortedSkills[0] ?? 0,
  p50: percentile(sortedSkills, 0.5), p90: percentile(sortedSkills, 0.9), max: sortedSkills.at(-1) ?? 0,
}

const jsonFlag = process.argv.indexOf('--json')
if (jsonFlag >= 0 && process.argv[jsonFlag + 1] !== undefined) {
  fs.writeFileSync(process.argv[jsonFlag + 1]!, JSON.stringify(report, null, 2))
  console.log(`\nwrote ${process.argv[jsonFlag + 1]}`)
}
