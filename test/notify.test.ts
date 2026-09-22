/**
 * The session notice for a plugin that cannot judge at all.
 *
 * The property under test is not "a string appears" — it is that the two
 * *silent* failures stop being silent without becoming noise: said once per
 * session, only for the reasons a human has to act on, and appended rather than
 * substituted into the step.
 *
 * @module dsh-jev-tools/test/notify
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createDegradeNotices, createDegradeNoticeListener } from '../lib/notify.js'
import { resolveSettings } from '../lib/config.js'
import { createContextCache } from '../lib/context-cache.js'

const SIGNAL = new AbortController().signal

/** A step payload for one agent. */
function payload (agentId: string) {
  return { agent: { id: agentId }, messages: [{ id: 'm1' }], turn: 3, signal: SIGNAL }
}

/** A continuation that lets the step through carrying one message. */
async function next (): Promise<{ kind: 'enter', messages: readonly unknown[] }> {
  return { kind: 'enter', messages: [{ id: 'm1' }] }
}

/** Build the listener with a conversation whose language the test picks. */
function harness (options: { task?: string, config?: unknown } = {}) {
  const cache = createContextCache()
  cache.remember('agent-1', options.task ?? 'fix the parser bug')
  const notices = createDegradeNotices()
  const listener = createDegradeNoticeListener({
    notices,
    settings: () => resolveSettings(options.config),
    cache,
    newMessageId: () => 'notice-1',
  })
  return { listener, notices }
}

/** The text of the last message, when the decision carried messages. */
function appended (decision: unknown): string | undefined {
  const shaped = decision as { kind?: string, messages?: readonly unknown[] }
  if (shaped.kind !== 'enter') return undefined
  const last = shaped.messages?.at(-1) as { content?: { text?: string }[] } | undefined
  return last?.content?.[0]?.text
}

test('nothing is said when no structural failure has been reported', async () => {
  const run = harness()
  const decision = await run.listener(payload('agent-1'), next)
  assert.deepEqual(decision, { kind: 'enter', messages: [{ id: 'm1' }] })
})

test('a transient failure is never worth a session notice', async () => {
  // These fix themselves, and one notice per blip is noise on top of noise.
  const run = harness()
  for (const reason of ['rate-limited', 'network', 'overloaded', 'server', 'too-small', 'disabled', 'shadow']) {
    run.notices.note('agent-1', reason)
  }
  assert.equal(run.notices.take('agent-1'), undefined)
  assert.equal(appended(await run.listener(payload('agent-1'), next)), undefined)
})

test('a missing key is said once per session, in the conversation language', async () => {
  const run = harness({ task: '帮我修一下解析器的 bug' })
  run.notices.note('agent-1', 'no-key')
  const first = appended(await run.listener(payload('agent-1'), next))
  assert.match(first ?? '', /没有可用的 API key/)
  assert.match(first ?? '', /TYPESAFE_API_KEY/)

  // Once means once: the state is structural, so repeating it is nagging.
  run.notices.note('agent-1', 'no-key')
  assert.equal(appended(await run.listener(payload('agent-1'), next)), undefined)
})

test('a 401 names the endpoint in force, which is the host the key has to match', async () => {
  // This is the failure the notice exists for: a key issued for another System
  // One host earns a 401 that fail-open would otherwise swallow whole.
  const run = harness({ config: { baseUrl: 'https://jev.example.com' } })
  run.notices.note('agent-1', 'unauthorized')
  const text = appended(await run.listener(payload('agent-1'), next)) ?? ''
  assert.match(text, /401/)
  assert.match(text, /https:\/\/jev\.example\.com/)
})

test('the notice never replaces what the step already carried', async () => {
  const run = harness()
  run.notices.note('agent-1', 'no-key')
  const decision = await run.listener(payload('agent-1'), next) as { kind: string, messages: unknown[] }
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 2)
  assert.deepEqual(decision.messages[0], { id: 'm1' })
})

test('a rejected step is passed through untouched', async () => {
  const run = harness()
  run.notices.note('agent-1', 'no-key')
  const rejected = await run.listener(payload('agent-1'), async () => ({ kind: 'reject' as const }))
  assert.deepEqual(rejected, { kind: 'reject' })
})

test('a switched-off plugin does not nag, and keeps the notice for when it is back on', async () => {
  const run = harness({ config: { enabled: false } })
  run.notices.note('agent-1', 'no-key')
  assert.equal(appended(await run.listener(payload('agent-1'), next)), undefined)
  // Still pending: the switch being off is not the same as the problem being gone.
  assert.equal(run.notices.take('agent-1'), 'no-key')
})

test('the first structural reason wins, so the explanation is not overwritten', () => {
  const notices = createDegradeNotices()
  notices.note('agent-1', 'no-key')
  notices.note('agent-1', 'unauthorized')
  assert.equal(notices.take('agent-1'), 'no-key')
})

test('bookkeeping is per agent and bounded', () => {
  const notices = createDegradeNotices()
  notices.note('a', 'no-key')
  assert.equal(notices.take('b'), undefined, 'one session must not consume another session\u2019s notice')
  assert.equal(notices.take('a'), 'no-key')

  // 64 sessions are remembered; the next one evicts the oldest.
  for (let i = 0; i < 64; i += 1) notices.note(`agent-${i}`, 'no-key')
  notices.note('overflow', 'no-key')
  assert.equal(notices.take('overflow'), 'no-key')
  assert.equal(notices.take('agent-0'), undefined, 'the oldest session is the one evicted')
})
