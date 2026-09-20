/**
 * Pre-flight request guards.
 *
 * These assert the limits from the published API contract and the shapes the
 * model's own documentation warns about — checked before anything leaves the
 * machine, which is the only place they can be enforced reliably.
 *
 * @module dsh-jev-tools/test/request
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MAX_CHOICE_OPTIONS,
  buildBody,
  estimateCostUsd,
  validateRequest,
} from '../lib/request.js'
import type { JudgmentRequest, Question } from '../lib/backends/types.js'

/** Wrap questions into a request with a small state. */
function request (questions: Record<string, Question>, state: unknown = 'ticket text'): JudgmentRequest {
  return { state: state as JudgmentRequest['state'], questions }
}

test('a well-formed request raises nothing', () => {
  const violations = validateRequest(request({
    refund: { type: 'noul', instructions: 'Is the customer asking for a refund?' },
    route: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'money', tech: 'bug' } },
    urgency: { type: 'score', instructions: 'How urgent?', criteria: ['low', 'normal', 'high'] },
  }))
  assert.deepEqual(violations, [])
})

test('an empty question map is refused', () => {
  const violations = validateRequest(request({}))
  assert.equal(violations.length, 1)
  assert.equal(violations[0]?.problem, 'no-questions')
})

test('a choice with no options is refused', () => {
  const violations = validateRequest(request({ pick: { type: 'choice', instructions: 'x', criteria: {} } }))
  assert.deepEqual(violations.map(v => v.problem), ['choice-empty'])
})

test('a choice above 255 options is refused, and names the count', () => {
  const criteria: Record<string, string> = {}
  for (let i = 0; i <= MAX_CHOICE_OPTIONS; i += 1) criteria[`option_${i}`] = `rubric ${i}`
  const violations = validateRequest(request({ pick: { type: 'choice', instructions: 'x', criteria } }))
  assert.deepEqual(violations.map(v => v.problem), ['choice-too-many'])
  assert.match(violations[0]!.detail, /256/)
})

test('exactly 255 options is allowed', () => {
  const criteria: Record<string, string> = {}
  for (let i = 0; i < MAX_CHOICE_OPTIONS; i += 1) criteria[`option_${i}`] = `rubric ${i}`
  assert.deepEqual(validateRequest(request({ pick: { type: 'choice', instructions: 'x', criteria } })), [])
})

test('score levels outside 2–10 are refused', () => {
  assert.deepEqual(
    validateRequest(request({ s: { type: 'score', instructions: 'x', criteria: ['only'] } })).map(v => v.problem),
    ['score-levels'])
  assert.deepEqual(
    validateRequest(request({ s: { type: 'score', instructions: 'x', criteria: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] } }))
      .map(v => v.problem),
    ['score-levels'])
})

test('an unknown question type is refused rather than sent', () => {
  const violations = validateRequest(request({ weird: { type: 'rank' } as unknown as Question }))
  assert.deepEqual(violations.map(v => v.problem), ['unknown-type'])
})

test('an oversized state is refused before it is sent, naming the numbers', () => {
  // 40k CJK characters estimate at ~40k tokens on their own.
  const violations = validateRequest(request(
    { q: { type: 'noul', instructions: 'x' } },
    '汉'.repeat(40_000)
  ))
  assert.ok(violations.some(v => v.problem === 'state-plus-question'))
  assert.match(violations.find(v => v.problem === 'state-plus-question')!.detail, /超过 32000/)
})

test('body construction keeps caller ids and omits an absent noul criteria', () => {
  const body = buildBody(request({
    'my.own.id': { type: 'noul', instructions: 'Is it so?' },
    routed: { type: 'choice', instructions: 'Where?', criteria: { a: 'rubric a' } },
  }), 'jev-latest')

  assert.equal(body.model, 'jev-latest')
  const questions = body.questions as Record<string, Record<string, unknown>>
  assert.deepEqual(Object.keys(questions).sort(), ['my.own.id', 'routed'])
  assert.equal('criteria' in questions['my.own.id']!, false)
  assert.deepEqual(questions.routed?.criteria, { a: 'rubric a' })
})

test('cost is input-only, because output tokens are free', () => {
  // $0.042 per million input tokens.
  assert.equal(estimateCostUsd(1_000_000), 0.042)
  assert.equal(estimateCostUsd(0), 0)
})
