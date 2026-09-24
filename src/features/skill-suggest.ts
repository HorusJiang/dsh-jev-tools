/**
 * Skill suggestion.
 *
 * Measured on real sessions: a typical catalog holds 29 skills (p50), and 100%
 * of observed catalogs held at least 20. Picking the right one out of thirty is
 * exactly the "many options, one answer" shape a judgment model is good at.
 *
 * Four properties are non-negotiable, and all four are asserted in tests:
 *
 *   - **Never reject.** This listener may only *add* a notice. It spreads the
 *     original messages and appends, so the step still runs unchanged if it
 *     decides to say anything at all.
 *   - **At most one judgment per turn.** The turn is latched when the request
 *     goes out, not when a notice is produced. Latching on the notice alone left
 *     an abstention — the common case on a vague turn — free to judge again on
 *     every later step of the same turn: three user turns produced four
 *     judgments on 2026-09-22. That spends a request each time and eats the
 *     per-turn allowance pruning shares, and pruning is the capability that
 *     actually changes what enters context.
 *   - **Silence beats a weak guess.** Below the confidence floor, and whenever
 *     the model picks the abstention option, nothing is injected.
 *   - **Every decline is recorded, once per (turn, reason).** A guard that
 *     returns without a ledger row makes the capability unfalsifiable: "never
 *     fired" and "fired and declined" would be the same observation from outside.
 *     This listener runs on every step and would otherwise bury its own evidence.
 *     The one path with no row is the latch hit itself — the turn's own row
 *     already says what happened, so one `suggest` row per turn stays the
 *     invariant.
 *
 * Unlike pruning, a short task is tolerated here: a wrong suggestion costs a
 * line of prompt, whereas a wrong prune loses content. That asymmetry is why
 * this capability has no minimum task length.
 *
 * @module dsh-jev-tools/features/skill-suggest
 */

import { JevError } from '../backends/jev.js'
import { resolveApiKey } from '../credentials.js'
import { reasonFromFailure, type SkipReason } from '../degrade.js'
import { detectLang, t } from '../i18n.js'
import type { DecisionBackend, JudgmentRequest } from '../backends/types.js'
import type { JevSettings } from '../config.js'
import type { ContextCache } from '../context-cache.js'
import type { Budget } from '../budget.js'
import type { Ledger } from '../ledger.js'
import type { DegradeNotices } from '../notify.js'
import type {
  CredentialsService, PreStepDecision, PreStepListener, SkillsService,
} from '../host.js'
import { noticeSource } from '../source.js'

/** Option name used to let the model decline. */
const ABSTAIN = 'none'

/** Longest skill description sent as a rubric. */
const MAX_DESCRIPTION = 200

/**
 * A latest message at least this long is judged on its own.
 *
 * The same measured floor pruning uses for `minTaskChars`: below it a request
 * carries no usable signal — "继续", "ok", "A" — and the recent window is the only
 * thing left to judge against.
 *
 * Above it, the current ask wins on **semantic** grounds, not on measured
 * accuracy. A controlled rerun (2026-09-22; identical criteria, only the task
 * text differing) left the winner unchanged and merely diluted it:
 * `lark-minutes` 0.510 alone against 0.470 with the window, top-two margin
 * 0.24 → 0.16. An earlier version of this comment claimed the window *flipped*
 * the winner. That comparison was confounded — the two sides differed in
 * criteria text as well as task text, and the flip came from the criteria.
 */
const MIN_LATEST_CHARS = 12

/** Ceiling on remembered agents per tracking map, so a long-lived host does not leak. */
const MAX_TRACKED = 64

/**
 * Drop the oldest entries until a per-agent tracking map is back under its ceiling.
 *
 * Maps preserve insertion order, so the first key is the least recently inserted.
 *
 * @param map - the tracking map to bound.
 */
function trimOldest<V> (map: Map<string, V>): void {
  while (map.size > MAX_TRACKED) {
    const oldest = map.keys().next()
    if (oldest.done === true) break
    map.delete(oldest.value)
  }
}

/** Dependencies the listener needs. */
export interface SkillSuggestDeps {
  readonly settings: () => JevSettings
  readonly credentials: () => CredentialsService | undefined
  readonly backendFor: (apiKey: string, model: string) => DecisionBackend
  readonly skills: () => SkillsService | undefined
  readonly cache: ContextCache
  readonly budget: Budget
  readonly ledger: Ledger
  /** Where a structural decline is reported, so it is not silent. */
  readonly notices: DegradeNotices
  readonly now: () => number
  readonly newMessageId: () => string
  /** Optional diagnostics sink; absent is fine. */
  readonly log?: (message: string) => void
}

/**
 * Create the `agent/pre-step` listener.
 *
 * @param deps - the capability's dependencies.
 * @returns the listener.
 */
export function createSkillSuggestListener (deps: SkillSuggestDeps): PreStepListener {
  /**
   * Last turn a judgment was *attempted* for, per agent.
   *
   * Latched when the request goes out, never on the answer — see the module
   * header for what latching on the notice cost.
   */
  const judgedTurn = new Map<string, number>()
  // The last skip already recorded per agent, as `turn\0reason`. `agent/pre-step`
  // fires on *every* step, so recording each guard on every pass would fill a
  // 1000-entry ledger with one repeated line and bury the evidence it exists to
  // carry. One record per (turn, reason) is enough to answer "why not?".
  const lastSkip = new Map<string, string>()
  /** Whether the structural "registry is not visible" warning has been logged this mount. */
  let warnedNoRegistry = false

  return async (payload, next): Promise<PreStepDecision> => {
    // Delegate first. A later listener keeps the last word on whether the step
    // runs, and a step that is about to be rejected costs no API request.
    const downstream = await next()
    // A rejected step is not this capability declining: the step itself is not
    // going to run, so there is nothing to explain and nothing to record.
    if (downstream.kind === 'reject') return downstream

    const agentId = payload.agent.id

    /**
     * Record why no suggestion was made, at most once per (turn, reason).
     *
     * Without this the listener is unfalsifiable. It has eight early returns and
     * every one of them used to be silent, so from the outside "it never ran"
     * and "it ran and declined" were the same observation — the ledger could not
     * tell them apart, which is the one question it exists to answer.
     *
     * @param reason - the guard that declined.
     * @returns whether a row was written, so a caller can gate a log line on it
     *   instead of warning on every single step.
     */
    const noteSkip = (reason: SkipReason): boolean => {
      const marker = `${payload.turn}\u0000${reason}`
      if (lastSkip.get(agentId) === marker) return false
      lastSkip.set(agentId, marker)
      trimOldest(lastSkip)
      deps.ledger.record({
        ts: deps.now(), agentId, feature: 'suggest', backendId: 'jev', model: '',
        latencyMs: 0, outcome: 'skipped', skip: reason,
      })
      return true
    }

    const settings = deps.settings()
    if (!settings.enabled || !settings.suggest.enabled) {
      noteSkip('disabled')
      return downstream
    }

    // The turn's own row already says what happened, so the latch hit is not
    // recorded again — one `suggest` row per turn is the invariant.
    if (judgedTurn.get(agentId) === payload.turn) return downstream

    // Prefer the current ask over a window that may still hold the previous
    // topic. This is a semantic choice, not an accuracy claim: a controlled
    // rerun had the window dilute the distribution without changing the winner
    // (see `MIN_LATEST_CHARS`). A latest message too short to carry signal still
    // falls back to the window, so "继续" keeps whatever made it meaningful.
    const latest = deps.cache.latest(agentId)
    const task = latest !== undefined && latest.length >= MIN_LATEST_CHARS
      ? latest
      : deps.cache.task(agentId)
    if (task === undefined || task.trim() === '') {
      noteSkip('no-task')
      return downstream
    }

    const skills = deps.skills()
    if (skills === undefined) {
      // Structural, not per-turn: the registry is not in this plugin's scope, so
      // the capability can never fire in this deployment. That deserves one host
      // warning per mount — repeating it on every step is log spam, not diagnosis.
      if (!warnedNoRegistry) {
        warnedNoRegistry = true
        deps.log?.('skills registry is not visible; suggestion can never fire')
      }
      noteSkip('no-skills')
      return downstream
    }

    let catalog
    try {
      // `scope` is not optional in practice. The registry reads the global layer
      // alone when it is omitted, and a preset's skills register into that
      // preset's layer, so an unscoped read reports a catalog the session does
      // not have — small enough to fall under the size floor every single time.
      // That is how this capability stayed silent in every session it ran in.
      catalog = await skills.list({
        scope: payload.agent,
        cwd: payload.agent.session?.header?.cwd,
      })
    } catch (error) {
      // Once per turn, not once per step: the same failure on every step of a
      // long turn would otherwise repeat identically in the host log.
      if (noteSkip('catalog-unavailable')) {
        deps.log?.(`catalog unavailable: ${String(error)}`)
      }
      return downstream
    }
    if (catalog.length < settings.suggest.minCatalogSize) {
      noteSkip('catalog-too-small')
      return downstream
    }

    const apiKey = await resolveApiKey(deps.credentials(), settings.apiKeyEnv)
    if (!apiKey.ok) {
      deps.notices.note(agentId, 'no-key')
      noteSkip('no-key')
      return downstream
    }

    const grant = deps.budget.tryConsume(agentId, payload.turn)
    if (!grant.ok) {
      noteSkip(grant.reason)
      return downstream
    }

    // A Choice caps at 255 options; the catalog is far smaller in practice, but
    // the guard keeps a pathological deployment from producing a rejected
    // request.
    const options = catalog.slice(0, 254)
    // English on purpose: this text goes to the model, not to the reader, and
    // the vendor documents English as its strongest training language.
    const criteria: Record<string, string> = {
      [ABSTAIN]: 'no skill is relevant to the current task',
    }
    for (const skill of options) {
      criteria[skill.name] = skill.description.slice(0, MAX_DESCRIPTION)
    }

    const model = settings.model
    const request: JudgmentRequest = {
      state: { task },
      questions: {
        pick: {
          type: 'choice',
          instructions:
            'Which single skill is most appropriate for `task`? Recommend only one. '
            + `If no skill is relevant, choose ${ABSTAIN}.`,
          criteria,
        },
      },
      model,
    }

    // Latch the turn *before* the request goes out. One judgment per turn has to
    // hold when the model abstains or the call fails exactly as much as when a
    // notice is produced — otherwise every later step of that turn pays again.
    judgedTurn.set(agentId, payload.turn)
    trimOldest(judgedTurn)

    const started = deps.now()
    let judged
    try {
      judged = await deps.backendFor(apiKey.value, model).judge(request, payload.signal)
    } catch (error) {
      const problem = error instanceof JevError ? error.problem : 'unknown'
      // One classification for both surfaces. These used to disagree: the notice
      // was mapped through `reasonFromFailure` while the ledger took
      // `problem as never`, which let an unrecognised string into a closed union
      // and made `/jev-status` render it as `skip.<garbage>`.
      const reason = reasonFromFailure(problem)
      deps.notices.note(agentId, reason)
      deps.ledger.record({
        ts: deps.now(), agentId, feature: 'suggest', backendId: 'jev', model: '',
        latencyMs: deps.now() - started, outcome: 'skipped', skip: reason,
      })
      return downstream
    }

    const answer = judged.answers.pick
    deps.ledger.record({
      ts: deps.now(), agentId, feature: 'suggest', backendId: 'jev',
      model: judged.model, requestedModel: judged.requestedModel,
      latencyMs: deps.now() - started,
      inputTokens: judged.usage?.inputTokens,
      outcome: 'judged',
    })

    if (answer === undefined || answer.type !== 'choice') return downstream
    if (answer.choice === ABSTAIN) return downstream
    if (answer.confidence < settings.suggest.minConfidence) return downstream
    const chosen = options.find(skill => skill.name === answer.choice)
    if (chosen === undefined) return downstream

    // Rendered in the conversation's language, like every other output.
    const lang = detectLang(task)
    const probability = answer.confidence.toFixed(2)
    const summary = lang === 'zh'
      ? `${chosen.name}（原始概率 ${probability}，未标定）`
      : `${chosen.name} (raw probability ${probability}, uncalibrated)`
    const notice = {
      id: deps.newMessageId(),
      role: 'user',
      content: [{ type: 'text', text: t(lang, 'suggest.notice', { summary }) }],
      source: noticeSource(summary),
    }

    // Append only. Spreading the delegated messages is what keeps this from
    // becoming a rewrite of the step.
    return { kind: 'enter', messages: [...downstream.messages, notice] }
  }
}
