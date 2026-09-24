/**
 * Semantic pruning of oversized tool results, and injection screening for
 * content about to enter the context.
 *
 * Two responsibilities share this listener because they share the same moment:
 * a tool result that is about to be read by the model. Pruning decides how much
 * of it to keep; screening asks whether it is addressing the agent. Keeping them
 * here rather than in two listeners is what lets **one request answer both** —
 * questions are judged in parallel and in isolation, so the second one is nearly
 * free, and two listeners would each send the whole payload.
 *
 * Triggered from `tools/post-execute`, which is an awaited waterfall on every
 * tool call — so what matters is not one call's latency but `trigger rate ×
 * latency`. S0 measured that: uncapped, a single turn can present 27 oversized
 * read-family results, about 8.1 s of added serial latency; capped at three it
 * is 0.9 s. Every guard below exists to keep that number honest.
 *
 * Three properties are non-negotiable:
 *
 *   - **Rank, never threshold.** The raw probabilities are known to be
 *     under-confident, which makes them a good ordering and a poor probability.
 *     Segments are therefore sorted and cut to a budget, not filtered at 0.5.
 *   - **Deterministic floors.** The head and tail are always kept, high-scoring
 *     segments are always kept, and the result never shrinks past a floor. A
 *     model that loses the beginning of a file cannot use the rest.
 *   - **Pure fail-open.** Anything unexpected returns the original payload.
 *     Pruning is an optimisation; it must never be the reason a task failed.
 *     Screening inherits this: it warns and never blocks.
 *
 * @module dsh-jev-tools/features/prune
 */

import { JevError } from '../backends/jev.js'
import { MAX_STATE_PLUS_QUESTION } from '../request.js'
import { estimateTokens } from '../tokens.js'
import { reasonFromFailure, type SkipReason } from '../degrade.js'
import type { DegradeNotices } from '../notify.js'
import { detectLang, t, type Lang } from '../i18n.js'
import {
  INJECTION_ID, injectionNotice, injectionQuestion, planScreening, readInjection,
} from './screen.js'
import type { DecisionBackend, JudgmentRequest, Question } from '../backends/types.js'
import type { JevSettings } from '../config.js'
import type { ContextCache } from '../context-cache.js'
import type { Budget } from '../budget.js'
import type { Memo } from '../memo.js'
import type { Ledger, LedgerFeature } from '../ledger.js'
import type { CredentialsService } from '../host.js'
import type {
  PostToolDecision, PostToolListener, ToolExecutionResultLike, ToolResultPrunerService,
} from '../host.js'
import { resolveApiKey } from '../credentials.js'
import { fingerprint } from '../memo.js'
import { noticeSource } from '../source.js'

/** Approximate token ceiling for one judged segment. */
const CHUNK_TOKENS = 400

/** Marker inserted where segments were dropped, so the reader knows something is missing. */
const OMISSION: Record<Lang, string> = {
  zh: '… [已省略 {n} 段] …',
  en: '… [{n} segments omitted] …',
}

/**
 * Ceiling on what the deterministic head/tail floors may claim, as a share of
 * the payload's tokens. The floors are configured in *lines*, but a payload can
 * be long in tokens and short in lines — a minified JSON blob, one enormous log
 * line — and without this cap the floor would claim the whole payload and
 * pruning could never happen at all.
 */
const FLOOR_TOKEN_SHARE = 0.5

/** Dependencies the listener needs. */
export interface PruneDeps {
  readonly settings: () => JevSettings
  readonly credentials: () => CredentialsService | undefined
  /** Build a backend for one resolved key. */
  readonly backendFor: (apiKey: string, model: string) => DecisionBackend
  /** DSH's own deterministic pruner, for the baseline measurement. */
  readonly pruner: () => ToolResultPrunerService | undefined
  readonly cache: ContextCache
  readonly budget: Budget
  readonly memo: Memo<readonly unknown[]>
  readonly ledger: Ledger
  /**
   * Where a decline that a reader has to know about is reported.
   *
   * Fail-open means the two structural failures (`no-key`, `unauthorized`)
   * leave no other trace, so this is what turns them from invisible into a
   * single line in the session.
   */
  readonly notices: DegradeNotices
  readonly now: () => number
  readonly newMessageId: () => string
}

/** One indivisible piece of the payload. */
interface Chunk {
  readonly text: string
  readonly lines: number
  readonly tokens: number
}

/** Whether a block is a text block. */
function isTextBlock (block: unknown): block is { type: 'text', text: string } {
  return block !== null && typeof block === 'object'
    && (block as { type?: unknown }).type === 'text'
    && typeof (block as { text?: unknown }).text === 'string'
}

/** Concatenate every text block of a payload, and remember which ones they were. */
function textOf (content: readonly unknown[]): string {
  let text = ''
  for (const block of content) if (isTextBlock(block)) text += `${block.text}\n`
  return text
}

/**
 * Split text into chunks that can each be judged on their own.
 *
 * Blank-line paragraphs are the natural unit; an oversized paragraph is split
 * by lines so no single question dominates the request's token budget.
 *
 * @param text - the payload text.
 * @returns the chunks, in original order.
 */
export function chunkText (text: string): Chunk[] {
  const chunks: Chunk[] = []
  const push = (raw: string): void => {
    const trimmed = raw.trim()
    if (trimmed === '') return
    const lines = trimmed.split('\n').length
    chunks.push({ text: `${trimmed}\n`, lines, tokens: estimateTokens(trimmed) })
  }

  for (const paragraph of text.split(/\n\s*\n/)) {
    if (estimateTokens(paragraph) <= CHUNK_TOKENS) {
      push(paragraph)
      continue
    }
    let bucket: string[] = []
    let bucketTokens = 0
    for (const line of paragraph.split('\n')) {
      const lineTokens = estimateTokens(line)
      if (bucketTokens > 0 && bucketTokens + lineTokens > CHUNK_TOKENS) {
        push(bucket.join('\n'))
        bucket = []
        bucketTokens = 0
      }
      bucket.push(line)
      bucketTokens += lineTokens
    }
    push(bucket.join('\n'))
  }
  return chunks
}

/**
 * Choose which chunks to keep.
 *
 * Ordering is by relevance, but the result is reassembled in the original
 * order and the floors are applied before the budget so a large irrelevant
 * opening can never crowd out a required one.
 *
 * @param chunks - the payload's chunks.
 * @param relevance - one probability per chunk, same order.
 * @param settings - the resolved prune settings.
 * @returns the kept indices, ascending, plus the resulting token count.
 */
export function selectChunks (
  chunks: readonly Chunk[],
  relevance: readonly number[],
  settings: JevSettings['prune']
): { keep: boolean[], keptTokens: number } {
  const keep = chunks.map(() => false)
  const original = chunks.reduce((sum, c) => sum + c.tokens, 0)

  // Deterministic floor 1: the head and the tail are always present. A model
  // that cannot see how a file starts cannot use anything that follows.
  //
  // Each end is capped by its share of the payload's tokens, but the first
  // chunk at each end is kept unconditionally — the guarantee only weakens as
  // far as it must for pruning to be possible at all.
  const endCap = (original * FLOOR_TOKEN_SHARE) / 2
  let head = 0
  let headTokens = 0
  for (let i = 0; i < chunks.length && head < settings.headLines; i += 1) {
    if (i > 0 && headTokens >= endCap) break
    keep[i] = true
    head += chunks[i]!.lines
    headTokens += chunks[i]!.tokens
  }
  let tail = 0
  let tailTokens = 0
  for (let i = chunks.length - 1; i >= 0 && tail < settings.tailLines; i -= 1) {
    if (i < chunks.length - 1 && tailTokens >= endCap) break
    keep[i] = true
    tail += chunks[i]!.lines
    tailTokens += chunks[i]!.tokens
  }

  // Deterministic floor 2: anything the model is confident about stays.
  for (let i = 0; i < chunks.length; i += 1) {
    if ((relevance[i] ?? 0) >= settings.keepHigh) keep[i] = true
  }

  // Fill the rest by relevance until the floor is reached. Note the target is
  // a *floor*, not a target: keeping more than `minKeepRatio` is always safe.
  const floor = original * settings.minKeepRatio
  let keptTokens = chunks.reduce((sum, c, i) => sum + (keep[i] === true ? c.tokens : 0), 0)
  const order = chunks
    .map((_, i) => i)
    .sort((a, b) => (relevance[b] ?? 0) - (relevance[a] ?? 0))
  for (const index of order) {
    if (keptTokens >= floor) break
    if (keep[index] === true) continue
    keep[index] = true
    keptTokens += chunks[index]!.tokens
  }

  return { keep, keptTokens }
}

/**
 * Reassemble the payload, marking each place where chunks were dropped.
 *
 * @param chunks - the payload's chunks.
 * @param keep - which chunks survived, same order.
 * @param content - the original content, kept for future block-level use.
 * @param lang - the language for the omission marker.
 * @returns the reassembled text.
 */
export function reassemble (
  chunks: readonly Chunk[],
  keep: readonly boolean[],
  content: readonly unknown[],
  lang: Lang
): string {
  const marker = (count: number): string => OMISSION[lang].replace('{n}', String(count))
  const parts: string[] = []
  let pending = 0
  for (let i = 0; i < chunks.length; i += 1) {
    if (keep[i] === true) {
      if (pending > 0) {
        parts.push(marker(pending))
        pending = 0
      }
      parts.push(chunks[i]!.text)
    } else {
      pending += 1
    }
  }
  if (pending > 0) parts.push(marker(pending))
  void content
  return parts.join('\n')
}

/** Replace the text blocks of a payload with `text`, preserving everything else. */
function withText (content: readonly unknown[], text: string): readonly unknown[] | undefined {
  const out: unknown[] = []
  let placed = false
  for (const block of content) {
    if (isTextBlock(block)) {
      if (!placed) {
        out.push({ type: 'text', text })
        placed = true
      }
      continue
    }
    // Images and any other block type are carried through untouched.
    out.push(block)
  }
  return placed ? out : undefined
}

/** Build the advisory notice attached to a pruned result. */
function notice (
  id: string,
  tool: string,
  before: number,
  after: number,
  kept: number,
  total: number,
  lang: Lang
): unknown {
  const keptLabel = lang === 'zh' ? `保留 ${kept}/${total} 段` : `kept ${kept}/${total} segments`
  const summary = `${tool}: ${Math.round(before)} → ${Math.round(after)} tokens (${keptLabel})`
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text: t(lang, 'prune.notice', { summary }) }],
    source: noticeSource(summary),
  }
}

/**
 * Build the notice attached in shadow mode.
 *
 * Same numbers as {@link notice}, different promise: nothing was changed, and
 * the text says so twice — once up front and once as what to do about it.
 */
function shadowNotice (
  id: string,
  tool: string,
  before: number,
  after: number,
  kept: number,
  total: number,
  lang: Lang
): unknown {
  const keptLabel = lang === 'zh' ? `保留 ${kept}/${total} 段` : `kept ${kept}/${total} segments`
  const summary = `${tool}: ${Math.round(before)} → ${Math.round(after)} tokens (${keptLabel})`
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text: t(lang, 'prune.shadowNotice', { summary }) }],
    source: noticeSource(`shadow · ${summary}`),
  }
}

/**
 * Create the `tools/post-execute` listener.
 *
 * @param deps - the capability's dependencies.
 * @returns the listener.
 */
export function createPruneListener (deps: PruneDeps): PostToolListener {
  return async (exec, result, next): Promise<PostToolDecision> => {
    const started = deps.now()
    const settings = deps.settings()
    const config = settings.prune
    const screenConfig = settings.screen

    // Delegate before judging so a downstream block costs no API request, and
    // so a later listener keeps the last word on whether the call was allowed.
    //
    // This must happen before the capability guards below, and every early
    // return from here on is `downstream` rather than a fresh decision:
    // `next()` may only be called once, so a guard that needs to decline has
    // nothing left to call.
    const downstream = await next()
    if (downstream.kind === 'block') return downstream
    if ('value' in downstream && downstream.value !== undefined) {
      // A value-shaped accept cannot carry replacement content.
      return downstream
    }

    // Cheapest checks first: each of these avoids a network round trip. The
    // master switch covers *both* responsibilities; `prune.enabled` covers only
    // pruning, and `screen.enabled` only screening.
    if (!settings.enabled) return downstream
    if (result.isError) return downstream
    if (exec.signal.aborted) return downstream

    const effective = 'content' in downstream && Array.isArray(downstream.content)
      ? downstream.content
      : result.content
    const sourceText = textOf(effective)
    const originalTokens = estimateTokens(sourceText)
    const withNotice = (content: readonly unknown[], ...messages: readonly unknown[]): PostToolDecision => ({
      kind: 'accept',
      content,
      additionalContexts: [...(downstream.additionalContexts ?? []), ...messages],
    })

    /**
     * The screening warning for this payload, once it is known.
     *
     * Set after the response is read, and read by `skip` below: a request that
     * carried the injection question must not drop its answer just because
     * pruning then declined. Paying for a judgment and discarding it is how a
     * warning about injected instructions silently fails to appear.
     */
    let pendingWarning: unknown

    /**
     * Record a declined attempt and pass the call through unchanged.
     *
     * Every decline returns `downstream` rather than a fresh decision: the
     * listener has already delegated, so the only safe outcome is the one the
     * rest of the waterfall produced.
     */
    const skip = (
      reason: SkipReason,
      extra: Partial<{ originalTokens: number }> = {},
      feature: LedgerFeature = 'prune'
    ): PostToolDecision => {
      // Reported before the record: a structural failure is worth a session
      // notice even if the ledger switch is off and this writes nothing.
      deps.notices.note(exec.agent?.id ?? '', reason)
      deps.ledger.record({
        ts: deps.now(),
        agentId: exec.agent?.id ?? '',
        feature,
        backendId: 'jev',
        model: '',
        latencyMs: deps.now() - started,
        outcome: 'skipped',
        skip: reason,
        ...extra,
      })
      return pendingWarning === undefined ? downstream : withNotice(effective, pendingWarning)
    }

    const agentId = exec.agent?.id ?? ''
    const task = deps.cache.task(agentId)
    // The conversation's own language, which is the signal that matters here: a
    // user reading an English session wants English output regardless of what
    // the interface happens to be set to.
    const lang = detectLang(task)

    // What each responsibility would do with this payload, decided up front so
    // that one request can carry both sets of questions.
    const prunable = config.enabled
      && config.toolAllowlist.includes(exec.name)
      && originalTokens > config.minTokens
    const screenPlan = planScreening({
      tool: exec.name, tokens: originalTokens, screen: screenConfig, pruneWillJudge: prunable,
    })

    // ── screening with nothing to ride along with ────────────────────────────
    //
    // This runs before the pruning guards on purpose: an injected instruction is
    // worth reporting even when pruning would decline this payload for reasons
    // of its own (too small, or a tool outside the pruning allowlist). It is the
    // only path that spends a request of its own.
    if (screenPlan === 'only') {
      const turn = deps.cache.turn(agentId) ?? 0
      const grant = deps.budget.tryConsume(agentId, turn)
      if (!grant.ok) return skip(grant.reason, { originalTokens }, 'screen')
      const apiKey = await resolveApiKey(deps.credentials(), settings.apiKeyEnv)
      if (!apiKey.ok) return skip('no-key', { originalTokens }, 'screen')

      const question = injectionQuestion('content')
      let screened
      try {
        screened = await deps.backendFor(apiKey.value, settings.model).judge({
          state: { task, content: sourceText },
          questions: { [INJECTION_ID]: question },
          model: settings.model,
        }, exec.signal)
      } catch (error) {
        const problem = error instanceof JevError ? error.problem : undefined
        return skip(reasonFromFailure(problem), { originalTokens }, 'screen')
      }

      const read = readInjection(screened.answers[INJECTION_ID], screenConfig.threshold)
      deps.ledger.record({
        ts: deps.now(), agentId, feature: 'screen', backendId: 'jev',
        model: screened.model, requestedModel: screened.requestedModel,
        latencyMs: deps.now() - started,
        inputTokens: screened.usage?.inputTokens,
        // An unreadable answer is a skip, never a clearance: "we could not tell"
        // must not be recorded as "we checked and it was fine".
        outcome: read === undefined ? 'skipped' : 'judged',
        ...(read === undefined ? { skip: 'malformed-response' as SkipReason } : {}),
      })
      if (read === undefined || !read.suspect) return downstream
      return withNotice(effective, injectionNotice(
        deps.newMessageId(), exec.name, read.probability, lang))
    }

    if (!config.enabled || !config.toolAllowlist.includes(exec.name)) return downstream
    if (originalTokens <= config.minTokens) return skip('too-small', { originalTokens })
    if (task === undefined) return skip('no-task', { originalTokens })
    // A terse message carries no usable signal, so relevance judged against it
    // is noise. Measured in practice: a two-character follow-up produced an
    // arbitrary 8/13 selection. Better to leave the payload alone.
    if (task.trim().length < config.minTaskChars) {
      return skip('task-too-vague', { originalTokens })
    }

    const turn = deps.cache.turn(agentId) ?? 0
    const grant = deps.budget.tryConsume(agentId, turn)
    if (!grant.ok) return skip(grant.reason, { originalTokens })

    const apiKey = await resolveApiKey(deps.credentials(), settings.apiKeyEnv)
    if (!apiKey.ok) return skip('no-key', { originalTokens })

    const chunks = chunkText(sourceText)
    if (chunks.length < 2) return skip('empty', { originalTokens })

    const model = settings.model
    // The key hashes the content itself, never its size: token counts are
    // character counts, so two different payloads of equal length would
    // otherwise share a key and one would be served the other's pruning.
    const key = fingerprint([
      exec.name, JSON.stringify(exec.arguments ?? null), sourceText, task, model,
    ])
    // The memo holds the *pruned* content, so it must not be consulted or
    // filled while shadow mode is on: a hit would serve the rewritten payload
    // that shadow mode exists to avoid applying. The cost is that identical
    // payloads are re-judged in shadow mode, which is also the point of it.
    const cached = config.shadow ? undefined : deps.memo.get(key)
    if (cached !== undefined) {
      return withNotice(cached, notice(
        deps.newMessageId(), exec.name, originalTokens,
        estimateTokens(textOf(cached)), chunks.length, chunks.length, lang))
    }

    // One request, one question per chunk: parallel sampling is the whole
    // reason this is affordable.
    const questions: Record<string, Question> = {}
    for (let i = 0; i < chunks.length; i += 1) {
      questions[`s${i}`] = {
        type: 'noul',
        // English on purpose: this text goes to the model, not to the reader,
        // and the vendor documents English as its strongest training language.
        instructions: `Is \`segments.s${i}\` directly relevant to \`task\`: `
          + 'does it contain material needed to locate, change, or cite something for that task?',
        criteria: {
          true: 'the segment contains specific material the task needs to locate, change, or cite',
          false: 'the segment is unrelated to the task — boilerplate, another file, or an already-finished log',
        },
      }
    }
    // Screening rides along when pruning is already judging this payload. This
    // is the whole reason the two responsibilities share one listener: the
    // questions are judged in parallel and in isolation, so the second one adds
    // almost no response time and needs no second copy of the payload.
    if (screenPlan === 'ride-along') questions[INJECTION_ID] = injectionQuestion('segments')
    const request: JudgmentRequest = {
      state: { task, segments: Object.fromEntries(chunks.map((c, i) => [`s${i}`, c.text])) },
      questions,
      model,
    }

    let judged
    try {
      judged = await deps.backendFor(apiKey.value, model).judge(request, exec.signal)
    } catch (error) {
      const problem = error instanceof JevError ? error.problem : undefined
      return skip(reasonFromFailure(problem), { originalTokens })
    }

    // Every chunk's answer must be readable, and this is the one place that can
    // be wrong in a way nothing else notices.
    //
    // A missing or wrong-typed answer is a *communication failure*, not a
    // confident "not relevant". Defaulting it to 0 would drop that segment,
    // bias the whole selection toward removing more, and still record the
    // judgment as `judged` — so the ledger would overstate success exactly when
    // the API was misbehaving. The backend reports these through
    // `unknownAnswers`, and nothing on this path read it.
    //
    // Fail open: pass the payload through untouched rather than guess.
    const relevance: number[] = []
    for (let i = 0; i < chunks.length; i += 1) {
      const answer = judged.answers[`s${i}`]
      if (answer === undefined || answer.type !== 'noul') {
        return skip('malformed-response', { originalTokens })
      }
      relevance.push(answer.noul)
    }

    // The injection answer, when this request carried one. A request that paid
    // for a judgment must not discard it just because pruning declines later,
    // so the warning is stashed on `pendingWarning` and `skip` picks it up.
    if (screenPlan === 'ride-along') {
      const read = readInjection(judged.answers[INJECTION_ID], screenConfig.threshold)
      deps.ledger.record({
        ts: deps.now(), agentId, feature: 'screen', backendId: 'jev',
        model: judged.model, requestedModel: judged.requestedModel,
        latencyMs: deps.now() - started,
        // Deliberately no `inputTokens`: this request is already accounted for
        // by the prune record below, and counting it twice would overstate cost.
        // An unreadable answer is a skip, never a clearance.
        outcome: read === undefined ? 'skipped' : 'judged',
        ...(read === undefined ? { skip: 'malformed-response' as SkipReason } : {}),
      })
      if (read !== undefined && read.suspect) {
        pendingWarning = injectionNotice(
          deps.newMessageId(), exec.name, read.probability, lang)
      }
    }

    // Guard against a payload that only fit because it was never sent: the
    // request builder also refuses this, and either refusal is a skip.
    if (estimateTokens(JSON.stringify(request.state)) > MAX_STATE_PLUS_QUESTION) {
      return skip('invalid-request', { originalTokens })
    }

    const { keep, keptTokens } = selectChunks(chunks, relevance, config)
    const saving = originalTokens === 0 ? 0 : (originalTokens - keptTokens) / originalTokens
    if (saving < config.minSaving) return skip('no-saving', { originalTokens })

    const rebuilt = withText(effective, reassemble(chunks, keep, effective, lang))
    if (rebuilt === undefined) return skip('empty', { originalTokens })

    // ── shadow mode: judge everything, change nothing ────────────────────────
    //
    // The request went out and the probabilities were paid for, so the numbers
    // are real; only the application is withheld. Recording it as `skipped`
    // with reason `shadow` is what keeps the ledger honest — its token totals
    // mean "removed from the context", and here nothing was removed.
    if (config.shadow) {
      const keptCount = keep.filter(Boolean).length
      deps.ledger.record({
        ts: deps.now(), agentId, feature: 'prune', backendId: 'jev',
        model: judged.model, requestedModel: judged.requestedModel,
        latencyMs: deps.now() - started,
        inputTokens: judged.usage?.inputTokens,
        outcome: 'skipped',
        skip: 'shadow',
        originalTokens, keptTokens,
        segments: chunks.length, segmentsKept: keptCount,
      })
      return withNotice(effective,
        shadowNotice(deps.newMessageId(), exec.name, originalTokens, keptTokens, keptCount, chunks.length, lang),
        ...(pendingWarning === undefined ? [] : [pendingWarning]))
    }

    // Remember the outcome so an identical payload is never sent twice: the
    // same content re-judged would cost latency and expose it again for nothing.
    deps.memo.set(key, rebuilt)

    // What DSH's own deterministic pruner would have kept on the same input.
    // This is the only way the increment over the existing baseline becomes a
    // measured number instead of an argument.
    let baselineKeptTokens: number | undefined
    try {
      const baseline = deps.pruner()?.pruneContent(effective)
      if (baseline !== undefined && baseline !== null) {
        baselineKeptTokens = estimateTokens(textOf(baseline))
      }
    } catch {
      baselineKeptTokens = undefined
    }

    deps.ledger.record({
      ts: deps.now(),
      agentId,
      feature: 'prune',
      backendId: 'jev',
      model: judged.model,
      requestedModel: judged.requestedModel,
      latencyMs: deps.now() - started,
      inputTokens: judged.usage?.inputTokens,
      outcome: 'judged',
      originalTokens,
      keptTokens,
      segments: chunks.length,
      segmentsKept: keep.filter(Boolean).length,
      ...(baselineKeptTokens === undefined ? {} : { baselineKeptTokens }),
    })

    const keptCount = keep.filter(Boolean).length
    // The injection warning goes last, so it is the most recent thing the model
    // reads about this payload. Both notices coexist: pruning says what was
    // kept, screening says how to read it.
    return withNotice(rebuilt, notice(
      deps.newMessageId(), exec.name, originalTokens, keptTokens, keptCount, chunks.length, lang),
      ...(pendingWarning === undefined ? [] : [pendingWarning]))
  }
}
