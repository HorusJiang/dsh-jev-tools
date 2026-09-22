/**
 * The TypeSafe System One backend.
 *
 * One endpoint serves every model; the body's `model` field selects. The
 * response's own `model` is the only durable record of what answered, because
 * aliases move between releases.
 *
 * Requests are validated before they are sent (`request.ts`), and a failure is
 * always a typed {@link JevError} carrying a machine-readable problem, so every
 * caller can degrade visibly instead of guessing from a message string.
 *
 * @module dsh-jev-tools/backends/jev
 */

import { postJson, type HttpDeps, type HttpProblem } from '../http.js'
import { DEFAULT_BASE_URL } from '../config.js'
import { SYSTEM_ONE_PATH, buildBody, validateRequest, type Violation } from '../request.js'
import type { Answer, DecisionBackend, JudgmentRequest, JudgmentResult } from './types.js'

/**
 * Default API root.
 *
 * Declared in `config.ts` so the setting's default and this backend's fallback
 * cannot drift into two different hosts; re-exported here because this module is
 * where a caller reads the backend's contract.
 */
export { DEFAULT_BASE_URL }

/** Default per-request timeout, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 10_000

/** Everything that can go wrong, as a value rather than a message. */
export type JevProblem =
  | 'invalid-request' | 'unauthorized' | 'bad-request' | 'rate-limited'
  | 'overloaded' | 'server' | 'network' | 'aborted' | 'malformed-response'

/** A failed judgment. */
export class JevError extends Error {
  readonly problem: JevProblem
  /** Present for `invalid-request`: which questions were unsendable and why. */
  readonly violations?: readonly Violation[]

  constructor (problem: JevProblem, message: string, violations?: readonly Violation[]) {
    super(message)
    this.name = 'JevError'
    this.problem = problem
    if (violations !== undefined) this.violations = violations
  }
}

/** Construction options for {@link createJevBackend}. */
export interface JevBackendOptions {
  /** Bearer token. Callers resolve this per operation; it is never cached here. */
  readonly apiKey: string
  /** Model id or alias. */
  readonly model: string
  /** System One API root, a bare host. Defaults to the vendor's own. */
  readonly baseUrl?: string
  readonly timeoutMs?: number
  /** Injectable transport, for tests. */
  readonly deps?: HttpDeps
}

/** Map the transport's classification onto this backend's. */
const PROBLEM_MAP: Readonly<Record<HttpProblem, JevProblem>> = {
  unauthorized: 'unauthorized',
  'bad-request': 'bad-request',
  'rate-limited': 'rate-limited',
  overloaded: 'overloaded',
  server: 'server',
  network: 'network',
  aborted: 'aborted',
}

/** Whether a value is a plain object. */
function isRecord (value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Whether a value is a finite number. */
function isNumber (value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Classify one wire answer.
 *
 * The three primitives are structurally disjoint, so an unrecognised `type`
 * means a newer server: it is reported through `unknownAnswers` rather than
 * dropped silently or allowed to poison the rest of the batch.
 *
 * @param raw - the answer as it arrived.
 * @returns the typed answer, or `undefined` when this client cannot read it.
 */
export function classifyAnswer (raw: unknown): Answer | undefined {
  if (!isRecord(raw)) return undefined
  if (raw.type === 'noul' && isNumber(raw.noul)) {
    // A Noul answer carries no `confidence` by design; the value is thresholded directly.
    return { type: 'noul', noul: raw.noul }
  }
  if (raw.type === 'choice' && typeof raw.choice === 'string' && isRecord(raw.probabilities) && isNumber(raw.confidence)) {
    return {
      type: 'choice',
      choice: raw.choice,
      probabilities: raw.probabilities as Record<string, number>,
      confidence: raw.confidence,
    }
  }
  if (raw.type === 'score' && isNumber(raw.score) && isRecord(raw.legend) && isRecord(raw.probabilities) && isNumber(raw.confidence)) {
    return {
      type: 'score',
      score: raw.score,
      legend: raw.legend as Record<string, string>,
      probabilities: raw.probabilities as Record<string, number>,
      confidence: raw.confidence,
    }
  }
  return undefined
}

/**
 * Create a Jev-backed {@link DecisionBackend}.
 *
 * @param options - credentials, model and transport overrides.
 * @returns the backend.
 */
export function createJevBackend (options: JevBackendOptions): DecisionBackend {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const deps = options.deps ?? {}

  return {
    id: 'jev',

    async judge (request: JudgmentRequest, signal: AbortSignal): Promise<JudgmentResult> {
      const violations = validateRequest(request)
      if (violations.length > 0) {
        throw new JevError(
          'invalid-request',
          `请求在发送前被拒绝：${violations.map(v => v.detail).join('；')}`,
          violations
        )
      }

      const model = request.model ?? options.model
      const outcome = await postJson({
        url: `${baseUrl}${SYSTEM_ONE_PATH}`,
        body: buildBody(request, model),
        headers: { authorization: `Bearer ${options.apiKey}` },
        signal,
        timeoutMs,
      }, deps)

      if (outcome.kind === 'error') {
        throw new JevError(PROBLEM_MAP[outcome.problem], outcome.message)
      }

      const body = outcome.body
      if (!isRecord(body) || typeof body.model !== 'string' || !isRecord(body.answers)) {
        throw new JevError('malformed-response', '响应缺少 model 或 answers 字段')
      }

      const answers: Record<string, Answer> = {}
      const unknownAnswers: string[] = []
      for (const [id, raw] of Object.entries(body.answers)) {
        const answer = classifyAnswer(raw)
        if (answer === undefined) unknownAnswers.push(id)
        else answers[id] = answer
      }

      const result: JudgmentResult = {
        // The version that answered, not the alias that was asked for.
        model: body.model,
        answers,
        requestedModel: model,
        ...(unknownAnswers.length > 0 ? { unknownAnswers } : {}),
        ...(isRecord(body.usage) && isNumber(body.usage.input_tokens)
          ? { usage: { inputTokens: body.usage.input_tokens, outputTokens: isNumber(body.usage.output_tokens) ? body.usage.output_tokens : 0 } }
          : {}),
      }
      return result
    },
  }
}
