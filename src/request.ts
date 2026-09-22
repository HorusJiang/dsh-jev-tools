/**
 * Request construction and pre-flight validation.
 *
 * Everything Jev's own documentation says not to do is checked here, before a
 * request leaves the machine, and reported as a specific violation naming the
 * offending question. Relying on the model to avoid these shapes does not work
 * — the guards have to be code.
 *
 * Limits come from the published API contract: at most 255 Choice options,
 * 2–10 Score levels, `state` plus the longest single question within 32k
 * tokens, and 64k for the request as a whole.
 *
 * @module dsh-jev-tools/request
 */

import { measureJson, estimateTokens } from './tokens.js'
import type { JudgmentRequest, Question } from './backends/types.js'

/** Maximum entries in one `choice` criteria map. */
export const MAX_CHOICE_OPTIONS = 255

/** Minimum `score` levels. */
export const MIN_SCORE_LEVELS = 2

/** Maximum `score` levels. */
export const MAX_SCORE_LEVELS = 10

/** Ceiling for `state` plus the longest single question. */
export const MAX_STATE_PLUS_QUESTION = 32_000

/** Ceiling for the whole request. */
export const MAX_REQUEST_TOKENS = 64_000

/** One reason a request must not be sent. */
export interface Violation {
  /** The offending question id, absent for request-wide problems. */
  readonly questionId?: string
  /** Stable machine-readable kind. */
  readonly problem: 'unknown-type' | 'choice-too-many' | 'choice-empty' | 'score-levels'
    | 'state-plus-question' | 'request-too-large' | 'no-questions'
  /** Human-readable detail, safe to show a model or a user. */
  readonly detail: string
}

/** Size accounting for one question, used by both the checks and the ledger. */
export interface QuestionSize {
  readonly id: string
  readonly tokens: number
}

/** Sizes measured for a request. */
export interface RequestSize {
  readonly stateTokens: number
  readonly questions: readonly QuestionSize[]
  readonly totalTokens: number
}

/**
 * Measure the request's token footprint.
 *
 * @param request - the request to measure.
 * @returns per-question and aggregate sizes.
 */
export function measureRequest (request: JudgmentRequest): RequestSize {
  const stateTokens = measureJson(request.state)
  const questions = Object.entries(request.questions).map(([id, question]) => ({
    id,
    tokens: measureJson(question.instructions) + measureJson(question.criteria),
  }))
  const totalTokens = stateTokens + questions.reduce((sum, entry) => sum + entry.tokens, 0)
  return { stateTokens, questions, totalTokens }
}

/**
 * Validate one question against the documented limits.
 *
 * @param id - the caller's question id, used only in diagnostics.
 * @param question - the question to check.
 * @returns every violation found; empty when the question is sendable.
 */
export function validateQuestion (id: string, question: Question): Violation[] {
  const violations: Violation[] = []
  switch (question.type) {
    case 'noul':
      // `criteria` is optional and any shape is accepted; nothing to check.
      break
    case 'choice': {
      const options = Object.keys(question.criteria ?? {})
      if (options.length === 0) {
        violations.push({ questionId: id, problem: 'choice-empty', detail: 'choice 至少需要一个选项' })
      } else if (options.length > MAX_CHOICE_OPTIONS) {
        violations.push({
          questionId: id,
          problem: 'choice-too-many',
          detail: `choice 有 ${options.length} 个选项，上限 ${MAX_CHOICE_OPTIONS}`,
        })
      }
      break
    }
    case 'score': {
      const levels = Array.isArray(question.criteria) ? question.criteria.length : 0
      if (levels < MIN_SCORE_LEVELS || levels > MAX_SCORE_LEVELS) {
        violations.push({
          questionId: id,
          problem: 'score-levels',
          detail: `score 有 ${levels} 级，必须在 ${MIN_SCORE_LEVELS}–${MAX_SCORE_LEVELS} 之间`,
        })
      }
      break
    }
    default:
      violations.push({
        questionId: id,
        problem: 'unknown-type',
        detail: `未知的问题类型 ${String((question as { type?: unknown }).type)}`,
      })
  }
  return violations
}

/**
 * Validate a whole request before it is sent.
 *
 * @param request - the request to check.
 * @returns every violation found; empty when the request may go out.
 */
export function validateRequest (request: JudgmentRequest): Violation[] {
  const violations: Violation[] = []
  const entries = Object.entries(request.questions)

  if (entries.length === 0) {
    violations.push({ problem: 'no-questions', detail: '至少需要一个 question' })
    return violations
  }

  for (const [id, question] of entries) {
    violations.push(...validateQuestion(id, question))
  }

  const size = measureRequest(request)
  const longest = size.questions.reduce((max, entry) => Math.max(max, entry.tokens), 0)
  if (size.stateTokens + longest > MAX_STATE_PLUS_QUESTION) {
    violations.push({
      problem: 'state-plus-question',
      detail: `state(${Math.round(size.stateTokens)}) + 最长问题(${Math.round(longest)}) 约 ${Math.round(size.stateTokens + longest)} tokens，超过 ${MAX_STATE_PLUS_QUESTION}`,
    })
  }
  if (size.totalTokens > MAX_REQUEST_TOKENS) {
    violations.push({
      problem: 'request-too-large',
      detail: `整个请求约 ${Math.round(size.totalTokens)} tokens，超过 ${MAX_REQUEST_TOKENS}`,
    })
  }

  return violations
}

/**
 * Build the wire body.
 *
 * Question ids are the caller's own map keys and are echoed back untouched;
 * they are never folded into `instructions`, so every question must be fully
 * self-describing.
 *
 * @param request - the validated request.
 * @param model - the model id or alias to send.
 * @returns the JSON body.
 */
export function buildBody (request: JudgmentRequest, model: string): Record<string, unknown> {
  const questions: Record<string, unknown> = {}
  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type === 'noul') {
      questions[id] = question.criteria === undefined
        ? { type: 'noul', instructions: question.instructions }
        : { type: 'noul', instructions: question.instructions, criteria: question.criteria }
    } else if (question.type === 'choice') {
      questions[id] = { type: 'choice', instructions: question.instructions, criteria: question.criteria }
    } else {
      questions[id] = { type: 'score', instructions: question.instructions, criteria: question.criteria }
    }
  }
  return { state: request.state, model, questions }
}

/** The endpoint every model shares; the `model` field selects. */
export const SYSTEM_ONE_PATH = '/v1/systemone'

/** Input price in US dollars per million tokens. Output is not billed. */
export const USD_PER_MTOK = 0.042

/**
 * Estimate the cost of one request, in US dollars.
 *
 * Input is billed at {@link USD_PER_MTOK} per million tokens and output is free,
 * so this is exact given a token count — it exists to make spend visible, not to
 * predict it. The price lives here rather than at each place that prints money,
 * because two copies of a price drift.
 *
 * @param inputTokens - the request's input tokens.
 * @returns the cost in dollars.
 */
export function estimateCostUsd (inputTokens: number): number {
  return (inputTokens / 1_000_000) * USD_PER_MTOK
}

/** Re-exported so callers measuring a raw string do not need two imports. */
export { estimateTokens }
