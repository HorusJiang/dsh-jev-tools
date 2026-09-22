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

/**
 * Area under the ROC curve, by rank.
 *
 * This is the Mann–Whitney U statistic, and it answers the one question a
 * calibration error cannot: **can this model tell the two classes apart at
 * all?** A perfectly calibrated but useless model scores 0.5 here, and a
 * saturated-but-informative one can score high while its ECE is terrible.
 *
 * Ties are given their average rank, so a model that answers a constant gets
 * 0.5 rather than a number that depends on the input order.
 *
 * @param samples - the labelled observations.
 * @returns AUC in [0, 1], or 0.5 when one class is absent — nothing can be
 *   ranked, and 0.5 is the value that says so instead of implying a skill.
 */
export function auc (samples: readonly Sample[]): number {
  const positives = samples.filter(sample => sample.y === 1).length
  const negatives = samples.length - positives
  if (positives === 0 || negatives === 0) return 0.5

  const sorted = [...samples].sort((left, right) => left.p - right.p)
  let rankSum = 0
  let index = 0
  while (index < sorted.length) {
    // One tie group: every equal score shares the group's average rank.
    let last = index
    while (last + 1 < sorted.length && sorted[last + 1]!.p === sorted[index]!.p) last += 1
    const averageRank = (index + last) / 2 + 1
    for (let at = index; at <= last; at += 1) {
      if (sorted[at]!.y === 1) rankSum += averageRank
    }
    index = last + 1
  }
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives)
}

/** One operating point: what a threshold does to a labelled set. */
export interface OperatingPoint {
  readonly threshold: number
  /** Of the samples called positive, the share that are. */
  readonly precision: number
  /** Of the truly positive samples, the share that were called. */
  readonly recall: number
  readonly f1: number
  /** How many samples this threshold calls positive. */
  readonly predicted: number
  readonly truePositives: number
}

/**
 * Score every threshold in a sweep.
 *
 * This is the step between "the model is calibrated" and "here is the cut-off
 * to use": pruning only ranks and needs no threshold, but a gate does, and the
 * sweep is what turns the choice into a measurement rather than a preference.
 *
 * @param samples - the labelled observations.
 * @param steps - how many thresholds to try, spread strictly inside (0, 1).
 * @returns one point per threshold, ascending.
 */
export function sweepThresholds (samples: readonly Sample[], steps = 19): OperatingPoint[] {
  const points: OperatingPoint[] = []
  for (let step = 1; step <= steps; step += 1) {
    const threshold = step / (steps + 1)
    let truePositives = 0
    let falsePositives = 0
    let falseNegatives = 0
    for (const sample of samples) {
      const called = sample.p >= threshold
      if (called && sample.y === 1) truePositives += 1
      else if (called) falsePositives += 1
      else if (sample.y === 1) falseNegatives += 1
    }
    const predicted = truePositives + falsePositives
    const precision = predicted === 0 ? 0 : truePositives / predicted
    const actualPositives = truePositives + falseNegatives
    const recall = actualPositives === 0 ? 0 : truePositives / actualPositives
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
    points.push({ threshold, precision, recall, f1, predicted, truePositives })
  }
  return points
}

/**
 * The sweep's best F1.
 *
 * A tie goes to the **higher** threshold: at the same F1 the stricter cut-off
 * spends less of the reader's attention on the cases that do not need it.
 *
 * @param points - a sweep, ascending in threshold.
 * @returns the chosen point, or `undefined` for an empty sweep.
 */
export function bestOperatingPoint (points: readonly OperatingPoint[]): OperatingPoint | undefined {
  let best: OperatingPoint | undefined
  for (const point of points) {
    if (best === undefined || point.f1 >= best.f1 - 1e-12) best = point
  }
  return best
}
