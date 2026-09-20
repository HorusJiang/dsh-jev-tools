/**
 * Probability calibration.
 *
 * Jev's raw numbers are not usable as probabilities, and the two independent
 * observations point in opposite directions depending on difficulty: on a hard
 * detection task its scores run *low* (a monitoring experiment found it "quite
 * shy"), while on an easy three-way classification it saturates at 1.000. So
 * neither a fixed threshold nor the raw value travels between tasks.
 *
 * What does travel is a *fitted* mapping on your own labelled data. This module
 * fits one and applies it — and binds the result to the model version that
 * answered, because an alias such as `jev-latest` moves between releases and a
 * mapping fitted on one version is meaningless on the next.
 *
 * v0.1 does not use this: pruning only *ranks*, and ranking needs no
 * calibration. It exists so the thresholds a gate will need are a fit away
 * rather than a guess, and so the runtime that produced the samples is on
 * record.
 *
 * @module dsh-jev-tools/calibrate
 */

/** One labelled observation: a raw probability and what actually happened. */
export interface Sample {
  /** The raw value the model reported, in [0, 1]. */
  readonly p: number
  /** The truth: 1 when the positive outcome occurred, otherwise 0. */
  readonly y: 0 | 1
}

/** A monotone step in an isotonic fit. */
export interface IsotonicKnot {
  readonly x: number
  readonly y: number
}

/** A fitted mapping, bound to the model version it came from. */
export interface CalibrationParams {
  /** The `model` field of the responses these samples came from. */
  readonly model: string
  /** Which fitter produced this. */
  readonly method: 'isotonic' | 'platt'
  /** Knots for `isotonic`, ascending in `x`. */
  readonly knots?: readonly IsotonicKnot[]
  /** Sigmoid coefficients for `platt`: `1 / (1 + exp(-(a * p + b)))`. */
  readonly a?: number
  readonly b?: number
  /** How many samples went into the fit. */
  readonly samples: number
  readonly fittedAt: number
}

/** The outcome of applying a mapping. */
export interface Calibrated {
  readonly p: number
  /** False when the mapping was ignored — unknown or fitted on another version. */
  readonly calibrated: boolean
  /** Why it was ignored, when it was. */
  readonly reason?: 'none' | 'version-mismatch' | 'too-few-samples'
}

/** Below this many samples isotonic regression overfits; Platt is the safer fit. */
const ISOTONIC_MIN_SAMPLES = 30

/** Gradient-descent settings for the Platt fit. */
const PLATT_EPOCHS = 2_000
const PLATT_RATE = 0.5

/** Clamp to the unit interval. */
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

/**
 * Fit by pool-adjacent-violators.
 *
 * Produces the best monotone non-decreasing step function under squared error —
 * which is exactly the shape wanted, because a monotone mapping can reorder
 * nothing: it changes the *values* while leaving the ranking that pruning
 * depends on completely intact.
 *
 * @param samples - the labelled observations.
 * @returns ascending knots.
 */
export function fitIsotonic (samples: readonly Sample[]): IsotonicKnot[] {
  const sorted = [...samples].sort((left, right) => left.p - right.p)
  interface Block { sum: number, weight: number, max: number }
  const blocks: Block[] = []

  for (const sample of sorted) {
    blocks.push({ sum: sample.y, weight: 1, max: sample.p })
    // Pool while the previous block's mean exceeds this one's.
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1]!
      const previous = blocks[blocks.length - 2]!
      if (previous.sum / previous.weight <= last.sum / last.weight) break
      blocks.pop()
      blocks.pop()
      blocks.push({
        sum: previous.sum + last.sum,
        weight: previous.weight + last.weight,
        max: last.max,
      })
    }
  }

  return blocks.map(block => ({ x: block.max, y: block.sum / block.weight }))
}

/**
 * Fit a logistic mapping by gradient descent.
 *
 * @param samples - the labelled observations.
 * @returns the sigmoid coefficients.
 */
export function fitPlatt (samples: readonly Sample[]): { a: number, b: number } {
  let a = 1
  let b = 0
  if (samples.length === 0) return { a, b }

  for (let epoch = 0; epoch < PLATT_EPOCHS; epoch += 1) {
    let gradA = 0
    let gradB = 0
    for (const sample of samples) {
      const predicted = 1 / (1 + Math.exp(-(a * sample.p + b)))
      const error = predicted - sample.y
      gradA += error * sample.p
      gradB += error
    }
    a -= (PLATT_RATE * gradA) / samples.length
    b -= (PLATT_RATE * gradB) / samples.length
  }
  return { a, b }
}

/**
 * Fit a mapping from labelled data.
 *
 * @param samples - the labelled observations.
 * @param model - the model version they came from; recorded, never inferred.
 * @param now - clock injection, for deterministic tests.
 * @returns the fitted parameters.
 */
export function fit (
  samples: readonly Sample[],
  model: string,
  now: () => number = Date.now
): CalibrationParams {
  const base = { model, samples: samples.length, fittedAt: now() }
  if (samples.length >= ISOTONIC_MIN_SAMPLES) {
    return { ...base, method: 'isotonic', knots: fitIsotonic(samples) }
  }
  const { a, b } = fitPlatt(samples)
  return { ...base, method: 'platt', a, b }
}

/** Interpolate an isotonic fit at `p`, clamping outside the fitted range. */
function interpolate (knots: readonly IsotonicKnot[], p: number): number {
  if (knots.length === 0) return p
  const first = knots[0]!
  const last = knots[knots.length - 1]!
  if (p <= first.x) return first.y
  if (p >= last.x) return last.y
  for (let i = 1; i < knots.length; i += 1) {
    const high = knots[i]!
    if (p > high.x) continue
    const low = knots[i - 1]!
    const span = high.x - low.x
    if (span <= 0) return high.y
    const ratio = (p - low.x) / span
    return low.y + ratio * (high.y - low.y)
  }
  return last.y
}

/**
 * Apply a mapping to a raw probability.
 *
 * Refuses to apply a mapping fitted on a different model version: aliases move
 * between releases, and silently reusing a stale mapping would be worse than
 * returning the raw value, because nothing downstream could tell.
 *
 * @param params - the fitted mapping, if any.
 * @param p - the raw probability.
 * @param model - the version that produced `p`.
 * @returns the mapped value and whether the mapping was actually used.
 */
export function apply (
  params: CalibrationParams | undefined,
  p: number,
  model: string
): Calibrated {
  if (params === undefined) return { p, calibrated: false, reason: 'none' }
  if (params.model !== model) return { p, calibrated: false, reason: 'version-mismatch' }
  if (params.samples === 0) return { p, calibrated: false, reason: 'too-few-samples' }

  if (params.method === 'isotonic') {
    return { p: clamp01(interpolate(params.knots ?? [], p)), calibrated: true }
  }
  const a = params.a ?? 1
  const b = params.b ?? 0
  return { p: clamp01(1 / (1 + Math.exp(-(a * p + b)))), calibrated: true }
}

/**
 * Mean absolute gap between predicted and observed, in ten equal-width bins.
 *
 * This is the number a threshold decision should be based on. A well-calibrated
 * model scores near zero; a model that always says 1.000 on a task it gets
 * right 70% of the time scores around 0.3.
 *
 * @param samples - the labelled observations, already mapped if that is the question.
 * @returns expected calibration error in [0, 1].
 */
export function expectedCalibrationError (samples: readonly Sample[]): number {
  if (samples.length === 0) return 0
  const bins = 10
  let total = 0
  for (let bin = 0; bin < bins; bin += 1) {
    const low = bin / bins
    const high = (bin + 1) / bins
    const inBin = samples.filter(sample =>
      sample.p >= low && (bin === bins - 1 ? sample.p <= high : sample.p < high))
    if (inBin.length === 0) continue
    const meanPredicted = inBin.reduce((sum, s) => sum + s.p, 0) / inBin.length
    const observed = inBin.reduce((sum, s) => sum + s.y, 0) / inBin.length
    total += (inBin.length / samples.length) * Math.abs(meanPredicted - observed)
  }
  return total
}
