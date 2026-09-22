/**
 * Calibration: fitting a mapping, applying it, and refusing to apply a stale one.
 *
 * @module dsh-jev-tools/test/calibrate
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  apply, auc, bestOperatingPoint, expectedCalibrationError, fit, fitIsotonic, fitPlatt, sweepThresholds,
} from '../lib/calibrate.js'
import type { Sample } from '../lib/calibrate.js'

/** An over-confident set: the model says 0.95 but is right two thirds of the time. */
function overconfident (count: number): Sample[] {
  const samples: Sample[] = []
  for (let i = 0; i < count; i += 1) samples.push({ p: 0.95, y: i % 3 === 0 ? 1 : 0 })
  return samples
}

test('isotonic output is monotone, which is what preserves the ranking', () => {
  const samples: Sample[] = [
    { p: 0.1, y: 1 }, { p: 0.2, y: 0 }, { p: 0.3, y: 1 },
    { p: 0.7, y: 0 }, { p: 0.8, y: 1 }, { p: 0.9, y: 1 },
  ]
  const knots = fitIsotonic(samples)
  assert.ok(knots.length > 0)
  for (let i = 1; i < knots.length; i += 1) {
    assert.ok(knots[i]!.x >= knots[i - 1]!.x, 'knots must ascend in x')
    assert.ok(knots[i]!.y >= knots[i - 1]!.y - 1e-12, 'fitted values must be non-decreasing')
  }
})

test('isotonic pulls an over-confident prediction down toward the observed rate', () => {
  const knots = fitIsotonic(overconfident(90))
  // Everything sits at 0.95 and is right about a third of the time, so the
  // fitted value there should be near 1/3, not near 0.95.
  for (const knot of knots) assert.ok(knot.y < 0.5, `expected a low fitted value, got ${knot.y}`)
})

test('a fit is bound to the version that produced the samples', () => {
  const params = fit(overconfident(90), 'jev-1.13.0', () => 1_000)
  assert.equal(params.model, 'jev-1.13.0')
  assert.equal(params.samples, 90)
  assert.equal(params.fittedAt, 1_000)
})

test('a mismatch of model version refuses the mapping rather than guessing', () => {
  // Aliases move between releases, so a mapping fitted on one version tells you
  // nothing about the next — and silently applying it would be undetectable.
  const params = fit(overconfident(90), 'jev-1.13.0', () => 1)
  const result = apply(params, 0.9, 'jev-1.14.0')
  assert.equal(result.calibrated, false)
  assert.equal(result.reason, 'version-mismatch')
  assert.equal(result.p, 0.9, 'the raw value passes through untouched')
})

test('no fitted mapping means identity, and says so', () => {
  const result = apply(undefined, 0.42, 'jev-1.13.0')
  assert.deepEqual(result, { p: 0.42, calibrated: false, reason: 'none' })
})

test('a matching version applies the mapping', () => {
  const params = fit(overconfident(90), 'jev-1.13.0', () => 1)
  const result = apply(params, 0.95, 'jev-1.13.0')
  assert.equal(result.calibrated, true)
  assert.ok(result.p < 0.5, `expected a lower calibrated value, got ${result.p}`)
  assert.ok(result.p >= 0, 'stays inside the unit interval')
})

test('a small sample falls back to the smoother Platt fit', () => {
  const params = fit(overconfident(10), 'jev-1.13.0', () => 1)
  assert.equal(params.method, 'platt')
  assert.ok(typeof params.a === 'number' && typeof params.b === 'number')
  // Isotonic overfits badly at this size, which is why it is not used here.
  assert.equal(params.knots, undefined)
})

test('the Platt fit also reduces over-confidence', () => {
  const { a, b } = fitPlatt(overconfident(20))
  const fitted = 1 / (1 + Math.exp(-(a * 0.95 + b)))
  assert.ok(fitted < 0.75, `expected a lower fitted value, got ${fitted}`)
})

test('an empty sample set is a no-op, not a crash', () => {
  const params = fit([], 'jev-1.13.0', () => 1)
  assert.equal(params.samples, 0)
  const result = apply(params, 0.7, 'jev-1.13.0')
  assert.equal(result.calibrated, false)
  assert.equal(result.p, 0.7)
})

test('applying never leaves the unit interval', () => {
  const params = fit([{ p: 0, y: 0 }, { p: 1, y: 1 }], 'm', () => 1)
  for (const p of [-5, 0, 0.5, 1, 5]) {
    const result = apply(params, p, 'm')
    assert.ok(result.p >= 0 && result.p <= 1, `out of range for input ${p}: ${result.p}`)
  }
})

test('reported calibration error reflects the actual over-confidence', () => {
  // Says 0.95, right one third of the time → roughly a 0.62 gap.
  const ece = expectedCalibrationError(overconfident(90))
  assert.ok(ece > 0.5 && ece < 0.7, `unexpected ECE ${ece}`)
  // A perfectly confident-and-correct set scores near zero.
  assert.ok(expectedCalibrationError([{ p: 1, y: 1 }, { p: 1, y: 1 }]) < 1e-9)
  assert.equal(expectedCalibrationError([]), 0)
})

test('AUC reports whether the scores rank at all, separately from calibration', () => {
  // A constant score is all ties: no ranking information, so 0.5 exactly.
  assert.equal(auc([{ p: 0.5, y: 1 }, { p: 0.5, y: 0 }, { p: 0.5, y: 1 }]), 0.5)
  // Every positive above every negative.
  assert.equal(auc([{ p: 0.1, y: 0 }, { p: 0.2, y: 0 }, { p: 0.9, y: 1 }, { p: 0.8, y: 1 }]), 1)
  // Inverted scores are reported as inverted, not silently folded to 0.5.
  assert.equal(auc([{ p: 0.9, y: 0 }, { p: 0.1, y: 1 }]), 0)
})

test('one class alone cannot be ranked, and says so instead of inventing skill', () => {
  assert.equal(auc([{ p: 0.9, y: 1 }, { p: 0.1, y: 1 }]), 0.5)
  assert.equal(auc([]), 0.5)
})

/** Two separated clusters: eight positives high, eight negatives low. */
function separated (): Sample[] {
  const samples: Sample[] = []
  for (let i = 0; i < 8; i += 1) samples.push({ p: 0.8 + i * 0.01, y: 1 })
  for (let i = 0; i < 8; i += 1) samples.push({ p: 0.1 + i * 0.01, y: 0 })
  return samples
}

test('the sweep finds the threshold a gate would actually use', () => {
  const points = sweepThresholds(separated())
  assert.equal(points.length, 19)
  // Ascending, and strictly inside (0, 1) so no threshold is degenerate.
  for (let i = 1; i < points.length; i += 1) assert.ok(points[i]!.threshold > points[i - 1]!.threshold)
  assert.ok(points.every(point => point.threshold > 0 && point.threshold < 1))

  const best = bestOperatingPoint(points)
  assert.ok(best !== undefined)
  assert.equal(best.f1, 1)
  assert.equal(best.precision, 1)
  assert.equal(best.recall, 1)
  assert.equal(best.predicted, 8, 'all eight positives, and none of the negatives')
  // 0.80 is the highest cut-off that still calls every positive, and the tie
  // break prefers it over the lower thresholds that score the same F1.
  assert.equal(best.threshold, 0.8)
})

test('a tie on F1 goes to the stricter threshold', () => {
  // Every cut-off between the clusters scores a perfect F1; the chosen one is
  // the highest, because the same F1 with less attention spent is the better gate.
  const points = sweepThresholds(separated())
  const best = bestOperatingPoint(points)!
  const tied = points.filter(point => Math.abs(point.f1 - best.f1) < 1e-12)
  assert.ok(tied.length > 1, 'this set is meant to tie at several thresholds')
  assert.equal(best.threshold, tied.at(-1)!.threshold)
})

test('an empty sample set yields no threshold to choose', () => {
  assert.equal(bestOperatingPoint([]), undefined)
  const points = sweepThresholds([])
  assert.equal(points.length, 19)
  for (const point of points) assert.equal(point.f1, 0)
})
