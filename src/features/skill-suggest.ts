/**
 * Skill suggestion.
 *
 * Measured on real sessions: a typical catalog holds 29 skills (p50), and 100%
 * of observed catalogs held at least 20. Picking the right one out of thirty is
 * exactly the "many options, one answer" shape a judgment model is good at.
 *
 * Three properties are non-negotiable, and all three are asserted in tests:
 *
 *   - **Never reject.** This listener may only *add* a notice. It spreads the
 *     original messages and appends, so the step still runs unchanged if it
 *     decides to say anything at all.
 *   - **At most one per turn.** A suggestion on every step would be noise on
 *     top of noise.
 *   - **Silence beats a weak guess.** Below the confidence floor, and whenever
 *     the model picks the abstention option, nothing is injected.
 *
 * Unlike pruning, a short task is tolerated here: a wrong suggestion costs a
 * line of prompt, whereas a wrong prune loses content. That asymmetry is why
 * this capability has no minimum task length.
 *
 * @module dsh-jev-tools/features/skill-suggest
 */

import { JevError } from '../backends/jev.js'
import { resolveApiKey } from '../credentials.js'
import { reasonFromFailure } from '../degrade.js'
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

/** Plugin identity used in the injected notice's source. */
const PLUGIN_ID = 'dsh-jev-tools'

/** Option name used to let the model decline. */
const ABSTAIN = 'none'

/** Longest skill description sent as a rubric. */
const MAX_DESCRIPTION = 200

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
  /** Last turn a suggestion was injected for, per agent. */
  const suggestedTurn = new Map<string, number>()

  return async (payload, next): Promise<PreStepDecision> => {
    // Delegate first. A later listener keeps the last word on whether the step
    // runs, and a step that is about to be rejected costs no API request.
    const downstream = await next()
    if (downstream.kind === 'reject') return downstream

    const settings = deps.settings()
    if (!settings.enabled || !settings.suggest.enabled) return downstream

    const agentId = payload.agent.id
    if (suggestedTurn.get(agentId) === payload.turn) return downstream

    const task = deps.cache.task(agentId)
    if (task === undefined || task.trim() === '') return downstream

    const skills = deps.skills()
    if (skills === undefined) return downstream

    let catalog
    try {
      catalog = await skills.list()
    } catch (error) {
      deps.log?.(`catalog unavailable: ${String(error)}`)
      return downstream
    }
    if (catalog.length < settings.suggest.minCatalogSize) return downstream

    const apiKey = await resolveApiKey(deps.credentials(), settings.apiKeyEnv)
    if (!apiKey.ok) {
      deps.notices.note(agentId, 'no-key')
      return downstream
    }

    const grant = deps.budget.tryConsume(agentId, payload.turn)
    if (!grant.ok) return downstream

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

    const started = deps.now()
    let judged
    try {
      judged = await deps.backendFor(apiKey.value, model).judge(request, payload.signal)
    } catch (error) {
      const problem = error instanceof JevError ? error.problem : 'unknown'
      deps.notices.note(agentId, reasonFromFailure(problem))
      deps.ledger.record({
        ts: deps.now(), agentId, feature: 'suggest', backendId: 'jev', model: '',
        latencyMs: deps.now() - started, outcome: 'skipped', skip: problem as never,
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

    suggestedTurn.set(agentId, payload.turn)
    while (suggestedTurn.size > 64) {
      const oldest = suggestedTurn.keys().next()
      if (oldest.done === true) break
      suggestedTurn.delete(oldest.value)
    }

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
      source: { kind: 'plugin', plugin: PLUGIN_ID, form: 'notice', summary },
    }

    // Append only. Spreading the delegated messages is what keeps this from
    // becoming a rewrite of the step.
    return { kind: 'enter', messages: [...downstream.messages, notice] }
  }
}
