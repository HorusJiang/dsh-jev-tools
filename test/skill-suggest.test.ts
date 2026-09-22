/**
 * Skill suggestion.
 *
 * The load-bearing assertions are the ones about what this listener may *never*
 * do: it is advisory, so it must never reject a step and must never rewrite the
 * messages it passes through.
 *
 * @module dsh-jev-tools/test/skill-suggest
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createSkillSuggestListener } from '../lib/features/skill-suggest.js'
import { createDegradeNotices } from '../lib/notify.js'
import { resolveSettings } from '../lib/config.js'
import { createBudget } from '../lib/budget.js'
import { createMemoryLedger } from '../lib/ledger.js'
import { createContextCache } from '../lib/context-cache.js'
import type { CredentialsService, PreStepDecision, SkillsService } from '../lib/host.js'

const SETTINGS = resolveSettings(undefined)
const SIGNAL = new AbortController().signal

const KEYED: CredentialsService = {
  resolve: async () => ({ value: 'sk-test', source: 'env' }),
  describe: async () => ({ configured: true, writable: true }),
}

/** A catalog large enough to pass the size floor. */
const CATALOG: SkillsService = {
  list: async () => Array.from({ length: 30 }, (_, i) => ({
    name: `skill-${i}`,
    description: `does thing number ${i}`,
  })),
}

/** Two pre-existing messages the listener must not disturb. */
const ORIGINAL = [{ role: 'user', content: [{ type: 'text', text: 'first' }] }, { role: 'user', content: [] }]

/** Build a listener plus handles for assertions. */
function harness (options: {
  key?: CredentialsService
  skills?: SkillsService
  choice?: string
  confidence?: number
  settings?: typeof SETTINGS
  throwOnJudge?: boolean
} = {}) {
  const cache = createContextCache()
  const ledger = createMemoryLedger()
  const notices = createDegradeNotices()
  let judgeCalls = 0
  const listener = createSkillSuggestListener({
    settings: () => options.settings ?? SETTINGS,
    credentials: () => options.key ?? KEYED,
    backendFor: () => ({
      id: 'fake',
      judge: async () => {
        judgeCalls += 1
        if (options.throwOnJudge === true) throw new Error('boom')
        return {
          model: 'jev-1.13.0',
          requestedModel: 'jev-latest',
          answers: {
            pick: {
              type: 'choice',
              choice: options.choice ?? 'skill-3',
              probabilities: { 'skill-3': options.confidence ?? 0.8 },
              confidence: options.confidence ?? 0.8,
            },
          },
        } as never
      },
    }),
    skills: () => options.skills ?? CATALOG,
    cache,
    budget: createBudget(3, 200),
    ledger,
    notices,
    now: () => 1_000,
    newMessageId: () => 'notice-1',
  })
  return { listener, cache, ledger, notices, calls: () => judgeCalls }
}

/** A `next` that records that it ran and preserves the messages. */
function passthrough (calls: { count: number }) {
  return async (): Promise<PreStepDecision> => {
    calls.count += 1
    return { kind: 'enter', messages: ORIGINAL }
  }
}

/** One step payload. */
const payload = (turn = 1) => ({ agent: { id: 'agent-1' }, messages: ORIGINAL, turn, signal: SIGNAL })

// ── the red lines ───────────────────────────────────────────────────────────

test('the listener never rejects a step', async () => {
  // Every outcome, including the happy path, must be an `enter`.
  for (const options of [
    {},
    { choice: 'none' },
    { confidence: 0.01 },
    { skills: { list: async () => [] } },
    { throwOnJudge: true },
  ]) {
    const { listener, cache } = harness(options)
    cache.remember('agent-1', '帮我加一个导出功能')
    const calls = { count: 0 }
    const decision = await listener(payload(), passthrough(calls))
    assert.notEqual(decision.kind, 'reject', `rejected for ${JSON.stringify(options)}`)
  }
})

test('the original messages are preserved verbatim and the notice is appended', async () => {
  const { listener, cache } = harness()
  cache.remember('agent-1', '帮我加一个导出功能')
  const calls = { count: 0 }
  const decision = await listener(payload(), passthrough(calls))

  assert.equal(decision.kind, 'enter')
  if (decision.kind !== 'enter') return
  // Exactly one message added, and every original message is untouched.
  assert.equal(decision.messages.length, ORIGINAL.length + 1)
  assert.deepEqual(decision.messages.slice(0, ORIGINAL.length), ORIGINAL)
  const notice = decision.messages.at(-1) as { source?: { form?: string, plugin?: string } }
  assert.equal(notice.source?.form, 'notice')
  assert.equal(notice.source?.plugin, 'dsh-jev-tools')
})

test('a suggestion is made at most once per turn', async () => {
  const { listener, cache, calls } = harness()
  cache.remember('agent-1', '帮我加一个导出功能')
  const nextCalls = { count: 0 }
  await listener(payload(1), passthrough(nextCalls))
  await listener(payload(1), passthrough(nextCalls))
  await listener(payload(1), passthrough(nextCalls))
  // One judgment for the whole turn, but every step still delegates onward.
  assert.equal(calls(), 1)
  assert.equal(nextCalls.count, 3)

  // A new turn is a fresh opportunity.
  await listener(payload(2), passthrough(nextCalls))
  assert.equal(calls(), 2)
  assert.equal(nextCalls.count, 4)
})

test('a downstream rejection is passed straight through, unjudged', async () => {
  // Delegation order matters: this listener must not be able to hide a step
  // from a listener that rejects it, nor spend a request on a doomed step.
  const { listener, cache, calls } = harness()
  cache.remember('agent-1', '帮我加一个导出功能')
  const decision = await listener(payload(), async () => ({ kind: 'reject' }))
  assert.deepEqual(decision, { kind: 'reject' })
  assert.equal(calls(), 0)
})

test('the notice is appended to what the downstream listener produced', async () => {
  const { listener, cache } = harness()
  cache.remember('agent-1', '帮我加一个导出功能')
  const downstreamMessages = [{ role: 'user', content: [{ type: 'text', text: 'downstream' }] }]
  const decision = await listener(payload(), async () => ({ kind: 'enter', messages: downstreamMessages }))
  assert.equal(decision.kind, 'enter')
  if (decision.kind !== 'enter') return
  assert.deepEqual(decision.messages.slice(0, 1), downstreamMessages)
  assert.equal(decision.messages.length, 2)
})

// ── the guards ──────────────────────────────────────────────────────────────

test('a small catalog is left alone', async () => {
  const small: SkillsService = { list: async () => [{ name: 'a', description: 'x' }] }
  const { listener, cache, calls } = harness({ skills: small })
  cache.remember('agent-1', '帮我加一个导出功能')
  await listener(payload(), passthrough({ count: 0 }))
  assert.equal(calls(), 0)
})

test('an unknown task sends nothing', async () => {
  const { listener, calls } = harness()
  await listener(payload(), passthrough({ count: 0 }))
  assert.equal(calls(), 0)
})

test('a disabled capability sends nothing', async () => {
  const { listener, cache, calls } = harness({ settings: resolveSettings({ suggest: { enabled: false } }) })
  cache.remember('agent-1', '帮我加一个导出功能')
  await listener(payload(), passthrough({ count: 0 }))
  assert.equal(calls(), 0)
})

test('a missing key sends nothing', async () => {
  const empty: CredentialsService = {
    resolve: async () => undefined,
    describe: async () => ({ configured: false, writable: true }),
  }
  const { listener, cache, notices, calls } = harness({ key: empty })
  cache.remember('agent-1', '帮我加一个导出功能')
  await listener(payload(), passthrough({ count: 0 }))
  assert.equal(calls(), 0)
  // Silence here is otherwise indistinguishable from "nothing to suggest".
  assert.equal(notices.take('agent-1'), 'no-key')
})

test('the abstention option produces silence, not a guess', async () => {
  const { listener, cache } = harness({ choice: 'none', confidence: 0.99 })
  cache.remember('agent-1', '帮我加一个导出功能')
  const decision = await listener(payload(), passthrough({ count: 0 }))
  assert.equal(decision.kind === 'enter' && decision.messages.length, ORIGINAL.length)
})

test('a low-confidence pick produces silence', async () => {
  const { listener, cache } = harness({ choice: 'skill-3', confidence: 0.05 })
  cache.remember('agent-1', '帮我加一个导出功能')
  const decision = await listener(payload(), passthrough({ count: 0 }))
  assert.equal(decision.kind === 'enter' && decision.messages.length, ORIGINAL.length)
})

test('a chosen name outside the catalog is ignored', async () => {
  const { listener, cache } = harness({ choice: 'not-a-skill', confidence: 0.9 })
  cache.remember('agent-1', '帮我加一个导出功能')
  const decision = await listener(payload(), passthrough({ count: 0 }))
  assert.equal(decision.kind === 'enter' && decision.messages.length, ORIGINAL.length)
})

test('a failing backend degrades to passing the step through', async () => {
  const { listener, cache, ledger } = harness({ throwOnJudge: true })
  cache.remember('agent-1', '帮我加一个导出功能')
  const calls = { count: 0 }
  const decision = await listener(payload(), passthrough(calls))
  assert.equal(calls.count, 1)
  assert.equal(decision.kind, 'enter')
  assert.equal(ledger.entries().at(-1)?.outcome, 'skipped')
})

test('a succeeding suggestion records the answering version', async () => {
  const { listener, cache, ledger } = harness()
  cache.remember('agent-1', '帮我加一个导出功能')
  await listener(payload(), passthrough({ count: 0 }))
  const record = ledger.entries().at(-1)
  assert.equal(record?.feature, 'suggest')
  assert.equal(record?.outcome, 'judged')
  assert.equal(record?.model, 'jev-1.13.0')
})
