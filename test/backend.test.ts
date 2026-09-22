/**
 * Transport retry policy and response handling.
 *
 * Each test drives a fake `fetch`, so the policy is pinned without a network,
 * and a fake `sleep`, so backoff is asserted without waiting.
 *
 * @module dsh-jev-tools/test/backend
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createJevBackend, classifyAnswer, JevError } from '../lib/backends/jev.js'
import { postJson } from '../lib/http.js'
import type { JudgmentRequest } from '../lib/backends/types.js'

/** A trivial valid request. */
const REQUEST: JudgmentRequest = {
  state: 'the ticket',
  questions: { refund: { type: 'noul', instructions: 'Is a refund requested?' } },
}

/** Build a JSON response. */
function json (body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

/** A recording fetch that replays a scripted list of responses. */
function scripted (responses: (Response | Error)[]): { impl: typeof fetch, calls: () => number } {
  let index = 0
  let calls = 0
  const impl = (async () => {
    calls += 1
    const next = responses[Math.min(index, responses.length - 1)]!
    index += 1
    if (next instanceof Error) throw next
    return next.clone()
  }) as unknown as typeof fetch
  return { impl, calls: () => calls }
}

/** A sleep that records delays instead of waiting. */
function recorder (): { sleep: (ms: number, signal: AbortSignal) => Promise<void>, delays: number[] } {
  const delays: number[] = []
  return { delays, sleep: async (ms) => { delays.push(ms) } }
}

test('401 is permanent: no retry', async () => {
  const fetchScript = scripted([json({ error: 'bad key' }, 401)])
  const outcome = await postJson(
    { url: 'https://x/y', body: {}, headers: {}, signal: new AbortController().signal, timeoutMs: 1000 },
    { fetchImpl: fetchScript.impl, sleep: recorder().sleep })
  assert.equal(outcome.kind, 'error')
  assert.equal(outcome.kind === 'error' && outcome.problem, 'unauthorized')
  assert.equal(fetchScript.calls(), 1)
})

test('422 is permanent and carries the server detail', async () => {
  const fetchScript = scripted([json({ detail: 'questions.urgency: too many levels' }, 422)])
  const outcome = await postJson(
    { url: 'https://x/y', body: {}, headers: {}, signal: new AbortController().signal, timeoutMs: 1000 },
    { fetchImpl: fetchScript.impl, sleep: recorder().sleep })
  assert.equal(outcome.kind === 'error' && outcome.problem, 'bad-request')
  assert.match(outcome.kind === 'error' ? outcome.message : '', /too many levels/)
  assert.equal(fetchScript.calls(), 1)
})

test('429 honours retry-after and then succeeds', async () => {
  const fetchScript = scripted([json({}, 429, { 'retry-after': '2' }), json({ ok: true })])
  const sleeper = recorder()
  const outcome = await postJson(
    { url: 'https://x/y', body: {}, headers: {}, signal: new AbortController().signal, timeoutMs: 1000 },
    { fetchImpl: fetchScript.impl, sleep: sleeper.sleep })
  assert.equal(outcome.kind, 'ok')
  assert.equal(fetchScript.calls(), 2)
  assert.deepEqual(sleeper.delays, [2000])
})

test('529 backs off and gives up after its retry budget', async () => {
  const fetchScript = scripted([json({}, 529)])
  const sleeper = recorder()
  const outcome = await postJson(
    { url: 'https://x/y', body: {}, headers: {}, signal: new AbortController().signal, timeoutMs: 1000 },
    { fetchImpl: fetchScript.impl, sleep: sleeper.sleep })
  assert.equal(outcome.kind === 'error' && outcome.problem, 'overloaded')
  // First attempt plus three retries.
  assert.equal(fetchScript.calls(), 4)
  assert.deepEqual(sleeper.delays, [250, 500, 1000])
})

test('a network failure retries fewer times than an overload', async () => {
  const fetchScript = scripted([new Error('ECONNREFUSED')])
  const sleeper = recorder()
  const outcome = await postJson(
    { url: 'https://x/y', body: {}, headers: {}, signal: new AbortController().signal, timeoutMs: 1000 },
    { fetchImpl: fetchScript.impl, sleep: sleeper.sleep })
  assert.equal(outcome.kind === 'error' && outcome.problem, 'network')
  assert.equal(fetchScript.calls(), 3) // first + 2 retries
})

test('an aborted call stops immediately and never retries', async () => {
  const controller = new AbortController()
  controller.abort()
  const fetchScript = scripted([json({ ok: true })])
  const outcome = await postJson(
    { url: 'https://x/y', body: {}, headers: {}, signal: controller.signal, timeoutMs: 1000 },
    { fetchImpl: fetchScript.impl, sleep: recorder().sleep })
  assert.equal(outcome.kind === 'error' && outcome.problem, 'aborted')
  assert.equal(fetchScript.calls(), 0)
})

test('a 200 that is not JSON is a failure, not a crash', async () => {
  const fetchScript = scripted([new Response('<html>gateway</html>', { status: 200 })])
  const outcome = await postJson(
    { url: 'https://x/y', body: {}, headers: {}, signal: new AbortController().signal, timeoutMs: 1000 },
    { fetchImpl: fetchScript.impl, sleep: recorder().sleep })
  assert.equal(outcome.kind === 'error' && outcome.problem, 'server')
})

test('an invalid request is refused locally, without any network call', async () => {
  const fetchScript = scripted([json({ model: 'never', answers: {} })])
  const backend = createJevBackend({
    apiKey: 'sk-x', model: 'jev-latest',
    deps: { fetchImpl: fetchScript.impl, sleep: recorder().sleep },
  })
  const bad: JudgmentRequest = { state: 'x', questions: { pick: { type: 'choice', instructions: 'x', criteria: {} } } }
  await assert.rejects(
    () => backend.judge(bad, new AbortController().signal),
    (error: unknown) => error instanceof JevError && error.problem === 'invalid-request')
  assert.equal(fetchScript.calls(), 0)
})

test('the answering version is recorded separately from the requested alias', async () => {
  const fetchScript = scripted([json({
    model: 'jev-1.13.0',
    answers: { refund: { type: 'noul', noul: 0.22 } },
    usage: { input_tokens: 400, output_tokens: 0 },
  })])
  const backend = createJevBackend({
    apiKey: 'sk-x', model: 'jev-latest',
    deps: { fetchImpl: fetchScript.impl, sleep: recorder().sleep },
  })
  const result = await backend.judge(REQUEST, new AbortController().signal)
  // The alias moves between releases; only the reported version is durable.
  assert.equal(result.requestedModel, 'jev-latest')
  assert.equal(result.model, 'jev-1.13.0')
  assert.equal(result.usage?.inputTokens, 400)
})

test('an unknown answer type is reported and does not poison its siblings', async () => {
  const fetchScript = scripted([json({
    model: 'jev-9.9.9',
    answers: {
      refund: { type: 'noul', noul: 0.72 },
      future_thing: { type: 'ranking', order: ['a', 'b'] },
    },
  })])
  const backend = createJevBackend({
    apiKey: 'sk-x', model: 'jev-latest',
    deps: { fetchImpl: fetchScript.impl, sleep: recorder().sleep },
  })
  const result = await backend.judge(REQUEST, new AbortController().signal)
  assert.deepEqual(result.unknownAnswers, ['future_thing'])
  assert.equal(result.answers.refund?.type, 'noul')
})

test('a response without a model version is malformed', async () => {
  const fetchScript = scripted([json({ answers: {} })])
  const backend = createJevBackend({
    apiKey: 'sk-x', model: 'jev-latest',
    deps: { fetchImpl: fetchScript.impl, sleep: recorder().sleep },
  })
  await assert.rejects(
    () => backend.judge(REQUEST, new AbortController().signal),
    (error: unknown) => error instanceof JevError && error.problem === 'malformed-response')
})

test('a configured baseUrl replaces the default host, path and all', async () => {
  // The vendor path is appended to whatever host is configured, and a trailing
  // slash must not become a doubled one. Both of these are the setting's whole
  // contract with the wire.
  const seen: string[] = []
  const impl = (async (url: string) => {
    seen.push(url)
    return json({ model: 'jev-1.13.0', answers: { refund: { type: 'noul', noul: 0.22 } } })
  }) as unknown as typeof fetch
  const deps = { fetchImpl: impl, sleep: recorder().sleep }
  for (const baseUrl of ['https://api.codiv.ai', 'https://api.codiv.ai/']) {
    const backend = createJevBackend({ apiKey: 'sk-x', model: 'jev-latest', baseUrl, deps })
    await backend.judge(REQUEST, new AbortController().signal)
  }
  assert.deepEqual(seen, [
    'https://api.codiv.ai/v1/systemone',
    'https://api.codiv.ai/v1/systemone',
  ])
})

test('a Noul answer carries no confidence, by the vendor\u2019s own contract', () => {
  const answer = classifyAnswer({ type: 'noul', noul: 0.22, confidence: 0.97 })
  assert.deepEqual(answer, { type: 'noul', noul: 0.22 })
})

test('the documented counterexample parses as the two disagreeing answers it is', () => {
  // TypeSafe's own worked example: the same ticket yields a Noul of 0.22 while
  // the equivalent Choice says yes at 0.01. Nothing here may reconcile them —
  // structural invariants between primitives are explicitly not guaranteed.
  const noul = classifyAnswer({ type: 'noul', noul: 0.22 })
  const choice = classifyAnswer({ type: 'choice', choice: 'no', probabilities: { yes: 0.01, no: 0.99 }, confidence: 0.97 })
  assert.equal(noul?.type === 'noul' && noul.noul, 0.22)
  assert.equal(choice?.type === 'choice' && choice.choice, 'no')
  assert.equal(choice?.type === 'choice' && choice.probabilities.yes, 0.01)
})
