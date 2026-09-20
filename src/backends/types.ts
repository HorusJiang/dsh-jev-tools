/**
 * The judgment vocabulary and the neutral backend seam.
 *
 * Kept separate from the TypeSafe implementation so the vendor is a swappable
 * detail rather than a foundation: Jev is an early-access model from a young
 * company with no published SLA, and the whole point of this seam is that
 * replacing it is a config change, not a rewrite.
 *
 * @module dsh-jev-tools/backends/types
 */

/** Values Jev accepts as `instructions`: a string, an object, or an array of either. */
export type InstructionValue = string | { readonly [key: string]: unknown } | readonly unknown[]

/** A yes/no question. `criteria` is optional and extends the instruction. */
export interface NoulQuestion {
  readonly type: 'noul'
  readonly instructions: InstructionValue
  readonly criteria?: { readonly true?: unknown, readonly false?: unknown }
}

/** Choose exactly one of a bounded, caller-defined set. */
export interface ChoiceQuestion {
  readonly type: 'choice'
  readonly instructions: InstructionValue
  /** Option → rubric. At most 255 entries. */
  readonly criteria: { readonly [option: string]: unknown }
}

/** Rate along an ordered scale. */
export interface ScoreQuestion {
  readonly type: 'score'
  readonly instructions: InstructionValue
  /** Ordered levels, most severe last. Between 2 and 10 entries. */
  readonly criteria: readonly unknown[]
}

/** One typed question. The map key is the caller's own id and never reaches the model. */
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion

/** Answer to a {@link NoulQuestion}. Carries no `confidence` — threshold the value itself. */
export interface NoulAnswer {
  readonly type: 'noul'
  readonly noul: number
}

/** Answer to a {@link ChoiceQuestion}. */
export interface ChoiceAnswer {
  readonly type: 'choice'
  readonly choice: string
  readonly probabilities: { readonly [option: string]: number }
  readonly confidence: number
}

/** Answer to a {@link ScoreQuestion}. `score` is probability-weighted and may land between levels. */
export interface ScoreAnswer {
  readonly type: 'score'
  readonly score: number
  readonly legend: { readonly [level: string]: string }
  readonly probabilities: { readonly [level: string]: number }
  readonly confidence: number
}

/** One answer of any kind. */
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer

/** What to judge. */
export interface JudgmentRequest {
  /** The material to assess: a string, an object, or an array of values. */
  readonly state: string | { readonly [key: string]: unknown } | readonly unknown[]
  /** Caller-keyed questions. Ids are echoed back and are never sent to the model. */
  readonly questions: { readonly [id: string]: Question }
  /** Model id or alias. The response's own `model` is what gets recorded. */
  readonly model?: string
}

/** What came back. */
export interface JudgmentResult {
  /** The version that actually answered. Aliases move, so this is the only durable fact. */
  readonly model: string
  readonly answers: { readonly [id: string]: Answer }
  readonly usage?: { readonly inputTokens: number, readonly outputTokens: number }
  /** The alias or id that was requested, for detecting that an alias moved. */
  readonly requestedModel?: string
  /** Answer ids whose type this client does not understand, reported rather than dropped silently. */
  readonly unknownAnswers?: readonly string[]
}

/** A swappable judgment backend. */
export interface DecisionBackend {
  readonly id: string
  judge (request: JudgmentRequest, signal: AbortSignal): Promise<JudgmentResult>
}
