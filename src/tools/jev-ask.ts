/**
 * The `jev_ask` tool: judgment the model asks for explicitly.
 *
 * This is the "optional enhancement" half of the plugin — nothing here is
 * guaranteed to happen, because the model has to decide to call it. That is
 * exactly why the pruning capability exists separately, triggered by code
 * rather than by the model remembering.
 *
 * A failure is always returned as a structured, self-explaining value rather
 * than thrown: a model that gets `{ ok: false, problem: 'no-key', hint: ... }`
 * can tell the user what to fix, whereas a thrown error usually surfaces as an
 * opaque tool failure.
 *
 * The tool *schema* is English because a model reads it. The *report* is
 * rendered in the conversation's language because a person reads it.
 *
 * @module dsh-jev-tools/tools/jev-ask
 */

import { JevError } from '../backends/jev.js'
import { validateRequest } from '../request.js'
import { resolveApiKey } from '../credentials.js'
import { skipMessage, type SkipReason } from '../degrade.js'
import { detectLang, t, type Lang } from '../i18n.js'
import { TYPESAFE_KEYS_URL, type JevSettings } from '../config.js'
import type { Answer, DecisionBackend, JudgmentRequest, Question } from '../backends/types.js'
import type { Budget } from '../budget.js'
import type { ContextCache } from '../context-cache.js'
import type { CredentialsService, ToolDefinitionLike } from '../host.js'
import type { Ledger } from '../ledger.js'

/** Dependencies the tool needs. */
export interface JevAskDeps {
  readonly settings: () => JevSettings
  readonly credentials: () => CredentialsService | undefined
  readonly backendFor: (apiKey: string, model: string) => DecisionBackend
  readonly cache: ContextCache
  readonly budget: Budget
  readonly ledger: Ledger
  readonly now: () => number
}

/** Format one answer for the reader. */
function describe (id: string, answer: Answer, lang: Lang): string {
  if (answer.type === 'noul') {
    // A Noul answer carries no confidence by the vendor's own contract.
    return t(lang, 'ask.noul', { id, p: answer.noul.toFixed(3) })
  }
  if (answer.type === 'choice') {
    const spread = Object.entries(answer.probabilities)
      .sort((a, b) => b[1] - a[1])
      .map(([option, p]) => `${option} ${p.toFixed(3)}`)
      .join(' / ')
    return t(lang, 'ask.choice', {
      id,
      choice: answer.choice,
      confidence: answer.confidence.toFixed(3),
      spread,
    })
  }
  const levels = Object.entries(answer.legend).map(([level, text]) => `${level}=${text}`).join(' / ')
  return t(lang, 'ask.score', {
    id,
    score: answer.score.toFixed(3),
    confidence: answer.confidence.toFixed(3),
    levels,
  })
}

/**
 * Build the tool definition.
 *
 * @param deps - what the tool reads.
 * @returns the definition to register.
 */
export function createJevAskTool (deps: JevAskDeps): ToolDefinitionLike {
  /**
   * Record a declined call so `/jev-status` can explain it later — and so the
   * conversation sees *why*.
   *
   * `report` is set here on purpose: the renderer reads only `report`, so a
   * decline that carried just `message`/`detail` displayed as the opaque
   * `(no judgment)`. A missing key, an invalid request and an exhausted quota
   * were then indistinguishable in the one place the README says these failures
   * are visible.
   */
  const declined = (
    problem: SkipReason,
    detail: string,
    lang: Lang,
    agentId: string
  ): Record<string, unknown> => {
    const message = skipMessage(problem, lang)
    deps.ledger.record({
      ts: deps.now(), agentId, feature: 'tool', backendId: 'jev', model: '',
      latencyMs: 0, outcome: 'skipped', skip: problem,
    })
    return { ok: false, problem, message, detail, report: `${message}\n${detail}` }
  }

  return {
    name: 'jev_ask',
    description:
      'Ask Jev for typed decisions over a piece of content: a yes/no with a probability, one choice '
      + 'from a defined set, or a score on an ordered scale. Every question is answered in one pass. '
      + 'Use it when the same judgment must be made many times (classify, route, triage, rank), '
      + 'never for text generation, counting, arithmetic or date comparison. Probabilities are '
      + 'uncalibrated and may saturate on easy inputs: rank with them, never read them as an '
      + 'accuracy figure or route on a fixed confidence threshold.',
    parameters: {
      type: 'object',
      properties: {
        state: {
          description: 'The material to judge: a string, an object, or an array. Keep it minimal — '
            + 'unrelated content in `state` measurably degrades accuracy.',
        },
        questions: {
          description:
            'Map of your own question id to a question object. Ids are echoed back verbatim and are '
            + 'never sent to the model, so every question must be self-describing in `instructions`. '
            + 'Shape: { type: "noul", instructions, criteria?: { true, false } } | '
            + '{ type: "choice", instructions, criteria: { option: rubric } } (at most 255 options) | '
            + '{ type: "score", instructions, criteria: [level0, level1, ...] } (2 to 10 levels). '
            + 'For multiple labels that can hold at once, use one `noul` per label instead of a `choice`.',
        },
        model: { type: 'string', description: 'Override the configured model for this call.' },
      },
      required: ['state', 'questions'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', description: 'Whether a judgment was produced.' },
          model: { type: 'string', description: 'The version that actually answered.' },
          report: { type: 'string', description: 'Human-readable answers.' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render (_args, value) {
        const shaped = value as { ok?: boolean, report?: string }
        return [{ type: 'text', text: shaped.report ?? '(no judgment)' }]
      },
    },
    isConcurrencySafe: () => true,
    timeoutMs: 15_000,

    async execute (rawArgs, exec) {
      const args = (rawArgs ?? {}) as { state?: unknown, questions?: unknown, model?: unknown }
      const settings = deps.settings()
      const agentId = exec.agent?.id ?? ''
      // Rendered in the conversation's language, like every other output.
      const lang = detectLang(deps.cache.task(agentId))

      if (!settings.enabled) {
        return declined('disabled', 'The plugin master switch is off.', lang, agentId)
      }

      const questions = args.questions
      if (questions === null || typeof questions !== 'object' || Array.isArray(questions)) {
        return declined('invalid-request', '`questions` must be an object: question id to question.',
          lang, agentId)
      }
      const request: JudgmentRequest = {
        state: (args.state ?? '') as JudgmentRequest['state'],
        questions: questions as Record<string, Question>,
        ...(typeof args.model === 'string' && args.model !== '' ? { model: args.model } : {}),
      }

      // Everything the vendor's documentation warns about is checked here,
      // before the content leaves the machine.
      const violations = validateRequest(request)
      if (violations.length > 0) {
        return declined('invalid-request', violations.map(v => v.detail).join('; '), lang, agentId)
      }

      const grant = deps.budget.tryConsumeSession(agentId)
      if (!grant.ok) {
        // `tryConsumeSession` can only refuse on the session ceiling, so the
        // detail now names the ceiling that actually stopped it. The old text
        // claimed the session allowance while the check was a per-turn one.
        return declined(grant.reason,
          `This session allows at most ${settings.sessionCallLimit} judgments, shared with automatic `
          + 'pruning and screening; raise the limit in the plugin settings.',
          lang, agentId)
      }

      const apiKey = await resolveApiKey(deps.credentials(), settings.apiKeyEnv)
      if (!apiKey.ok) {
        return {
          ...declined('no-key', `Could not resolve a key from ${settings.apiKeyEnv}.`, lang, agentId),
          hint: `Create an API key at ${TYPESAFE_KEYS_URL} and paste it into the plugin settings page, `
            + `or set the environment variable ${settings.apiKeyEnv}.`,
        }
      }

      const model = request.model ?? settings.model
      const started = deps.now()
      let judged
      try {
        judged = await deps.backendFor(apiKey.value, model).judge(request, exec.signal)
      } catch (error) {
        const problem = error instanceof JevError ? error.problem : 'unknown'
        const detail = error instanceof Error ? error.message : String(error)
        return declined(problem as SkipReason, detail, lang, agentId)
      }

      deps.ledger.record({
        ts: deps.now(), agentId, feature: 'tool', backendId: 'jev',
        model: judged.model, requestedModel: judged.requestedModel,
        latencyMs: deps.now() - started,
        inputTokens: judged.usage?.inputTokens,
        outcome: 'judged',
      })

      const lines: string[] = []
      for (const [id, answer] of Object.entries(judged.answers)) lines.push(describe(id, answer, lang))
      const missing = Object.keys(request.questions).filter(id => judged.answers[id] === undefined)
      if (missing.length > 0) lines.push(t(lang, 'ask.missing', { ids: missing.join(', ') }))
      if (judged.unknownAnswers !== undefined && judged.unknownAnswers.length > 0) {
        lines.push(t(lang, 'ask.unknownTypes', { ids: judged.unknownAnswers.join(', ') }))
      }

      const alias = judged.requestedModel !== undefined && judged.requestedModel !== judged.model
        ? t(lang, 'ask.alias', { alias: judged.requestedModel })
        : ''
      const header = t(lang, 'ask.header', {
        model: judged.model,
        alias,
        tokens: judged.usage?.inputTokens ?? '?',
      })

      return {
        ok: true,
        model: judged.model,
        requestedModel: judged.requestedModel ?? model,
        calibrated: false,
        answers: judged.answers,
        ...(judged.usage === undefined ? {} : { usage: judged.usage }),
        report: `${header}\n\n${lines.join('\n')}`,
      }
    },
  }
}
