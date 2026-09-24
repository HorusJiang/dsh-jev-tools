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
import { skipMessage } from '../lib/degrade.js'
import type {
  CredentialsService, PreStepDecision, SkillsService, SkillViewOptionsLike,
} from '../lib/host.js'

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
  /** Captures the judgment request, so a test can assert what was actually sent. */
  onJudge?: (request: { state?: unknown }) => void
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
      judge: async (request: { state?: unknown }) => {
        judgeCalls += 1
        options.onJudge?.(request)
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
    // Distinguish "not supplied" (use the large default catalog) from an
    // explicitly absent registry, which is a different code path.
    skills: () => ('skills' in options ? options.skills : CATALOG),
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
  const notice = decision.messages.at(-1) as { source?: { kind?: string, form?: string } }
  assert.equal(notice.source?.kind, 'plugin:dsh-jev-tools')
  assert.equal(notice.source?.form, 'notice')
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

test('an abstention latches the turn, so later steps do not judge again', async () => {
  // The regression this exists for. The turn used to be latched only once a
  // notice was actually produced, so an abstention — the normal outcome on a
  // vague turn — left nothing latched and every later step of that turn judged
  // again. Measured 2026-09-22: three user turns produced four judgments, each
  // one spending the per-turn allowance that pruning shares.
  const { listener, cache, ledger, calls } = harness({ choice: 'none', confidence: 0.99 })
  cache.remember('agent-1', '帮我加一个导出功能')
  const nextCalls = { count: 0 }
  await listener(payload(1), passthrough(nextCalls))
  await listener(payload(1), passthrough(nextCalls))
  await listener(payload(1), passthrough(nextCalls))

  assert.equal(calls(), 1, 'three steps of one turn must cost one judgment')
  assert.equal(nextCalls.count, 3, 'every step still delegates onward')
  // One row per turn stays the invariant: the latch hit writes nothing.
  assert.equal(ledger.entries().filter(entry => entry.feature === 'suggest').length, 1)

  // The next turn is a fresh attempt.
  await listener(payload(2), passthrough(nextCalls))
  assert.equal(calls(), 2)
})

test('a low-confidence pick latches the turn too', async () => {
  // Same shape as an abstention: the answer arrived, it just was not usable.
  const { listener, cache, calls } = harness({ choice: 'skill-3', confidence: 0.05 })
  cache.remember('agent-1', '帮我加一个导出功能')
  const nextCalls = { count: 0 }
  await listener(payload(1), passthrough(nextCalls))
  await listener(payload(1), passthrough(nextCalls))
  assert.equal(calls(), 1)
})

test('a failed judgment is not retried on later steps of the same turn', async () => {
  // The request was already paid for, and the task text does not change within a
  // turn — a retry would spend the same allowance to ask the same question.
  const { listener, cache, calls } = harness({ throwOnJudge: true })
  cache.remember('agent-1', '帮我加一个导出功能')
  const nextCalls = { count: 0 }
  await listener(payload(1), passthrough(nextCalls))
  await listener(payload(1), passthrough(nextCalls))
  assert.equal(calls(), 1)

  await listener(payload(2), passthrough(nextCalls))
  assert.equal(calls(), 2)
})

test('a backend failure records a reason the catalog can render', async () => {
  // The ledger used to take `problem as never`, an unsound cast that happened to
  // be safe only because every `JevProblem` value has wording. Pin the invariant
  // instead of the cast: whatever lands in `skip`, `/jev-status` renders it.
  const { listener, cache, ledger } = harness({ throwOnJudge: true })
  cache.remember('agent-1', '帮我加一个导出功能')
  await listener(payload(), passthrough({ count: 0 }))

  const reason = ledger.entries().at(-1)?.skip
  assert.ok(reason !== undefined, 'a failed judgment must still be recorded')
  for (const lang of ['zh', 'en'] as const) {
    assert.notEqual(skipMessage(reason, lang), `skip.${reason}`, `${reason} has no ${lang} wording`)
  }
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

// ── every decline has to be legible from the ledger ─────────────────────────
//
// These are the assertions that make the capability falsifiable. Without a
// record, "never fired" and "fired and declined eight different ways" are the
// same observation, and the ledger exists precisely to separate them.

test('a small catalog records why nothing was suggested', async () => {
  const small: SkillsService = { list: async () => [{ name: 'a', description: 'x' }] }
  const { listener, cache, ledger } = harness({ skills: small })
  cache.remember('agent-1', '帮我加一个导出功能')
  await listener(payload(), passthrough({ count: 0 }))
  const record = ledger.entries().at(-1)
  assert.equal(record?.feature, 'suggest')
  assert.equal(record?.outcome, 'skipped')
  assert.equal(record?.skip, 'catalog-too-small')
})

test('an invisible skill registry is recorded, not silently swallowed', async () => {
  const { listener, cache, ledger } = harness({ skills: undefined })
  cache.remember('agent-1', '帮我加一个导出功能')
  await listener(payload(), passthrough({ count: 0 }))
  assert.equal(ledger.entries().at(-1)?.skip, 'no-skills')
})

test('an unreadable catalog is recorded, not silently swallowed', async () => {
  const broken: SkillsService = {
    list: async () => { throw new Error('nope') },
  }
  const { listener, cache, ledger } = harness({ skills: broken })
  cache.remember('agent-1', '帮我加一个导出功能')
  await listener(payload(), passthrough({ count: 0 }))
  assert.equal(ledger.entries().at(-1)?.skip, 'catalog-unavailable')
})

test('an unknown task records why nothing was suggested', async () => {
  const { listener, ledger } = harness()
  await listener(payload(), passthrough({ count: 0 }))
  assert.equal(ledger.entries().at(-1)?.skip, 'no-task')
})

test('a long latest message is judged on its own, not through the topic window', async () => {
  // The window answers "what is this session working on" — pruning's question.
  // A suggestion answers "what is being asked right now". This is a semantic
  // choice, not an accuracy claim: a controlled rerun had the window dilute the
  // distribution without changing the winner.
  const seen: unknown[] = []
  const { listener, cache } = harness({ onJudge: request => { seen.push(request.state) } })
  cache.remember('agent-1', '帮我加一个导出功能')
  cache.remember('agent-1', '下周三跟客户开会，帮我把上次那场会的妙记翻出来并整理待办')
  await listener(payload(), passthrough({ count: 0 }))

  assert.deepEqual(seen, [{ task: '下周三跟客户开会，帮我把上次那场会的妙记翻出来并整理待办' }])
})

test('a terse latest message still falls back to the topic window', async () => {
  // "继续" on its own carries no signal, so the window is all there is to judge.
  const seen: unknown[] = []
  const { listener, cache } = harness({ onJudge: request => { seen.push(request.state) } })
  cache.remember('agent-1', '帮我加一个导出功能')
  cache.remember('agent-1', '继续')
  await listener(payload(), passthrough({ count: 0 }))

  assert.deepEqual(seen, [{ task: '帮我加一个导出功能\n继续' }])
})

test('the catalog is read in the viewing agent scope, not the global layer alone', async () => {
  // `ctx.skills.list()` with no scope reads the global layer *alone* (see the
  // host's `packages/skill/skill/src/index.ts`: "omitted reads the global layer
  // alone"), while an agent preset's standing composition registers into that
  // preset's layer. So an unscoped read reports a catalog the session does not
  // have — under the size floor, silently, on every turn. This is that bug.
  const seen: SkillViewOptionsLike[] = []
  const scoped: SkillsService = {
    list: async (options) => {
      if (options !== undefined) seen.push(options)
      return options?.scope === undefined
        ? []
        : Array.from({ length: 30 }, (_, i) => ({ name: `skill-${i}`, description: `d${i}` }))
    },
  }
  const { listener, cache, calls } = harness({ skills: scoped })
  cache.remember('agent-1', '帮我加一个导出功能')
  const step = payload()
  await listener(step, passthrough({ count: 0 }))

  assert.equal(calls(), 1, 'a globally-empty catalog must still be read in scope')
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.scope, step.agent)
})

test('the workspace root travels with the scoped read when the host exposes one', async () => {
  const seen: SkillViewOptionsLike[] = []
  const scoped: SkillsService = {
    list: async (options) => {
      if (options !== undefined) seen.push(options)
      return []
    },
  }
  const { listener, cache } = harness({ skills: scoped })
  cache.remember('agent-1', '帮我加一个导出功能')
  const step = {
    ...payload(),
    agent: { id: 'agent-1', session: { header: { cwd: '/work/project' } } },
  }
  await listener(step, passthrough({ count: 0 }))
  assert.equal(seen[0]?.cwd, '/work/project')
})

test('one decline is recorded once per turn, not once per step', async () => {
  // This listener runs on every step of a turn. An undeduplicated record would
  // fill a 1000-entry ledger with the same line and bury the evidence it exists
  // to carry, so the record is keyed by (turn, reason).
  const empty: SkillsService = { list: async () => [] }
  const { listener, cache, ledger } = harness({ skills: empty })
  cache.remember('agent-1', '帮我加一个导出功能')
  for (let step = 0; step < 4; step += 1) {
    await listener(payload(7), passthrough({ count: 0 }))
  }
  const recorded = ledger.entries().filter(entry => entry.feature === 'suggest')
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0]?.skip, 'catalog-too-small')

  // A later turn is a fresh observation.
  await listener(payload(8), passthrough({ count: 0 }))
  assert.equal(ledger.entries().filter(entry => entry.feature === 'suggest').length, 2)
})

test('a step rejected by someone else is not recorded as this plugin declining', async () => {
  // The step is not going to run at all, so there is nothing to explain.
  const { listener, cache, ledger } = harness()
  cache.remember('agent-1', '帮我加一个导出功能')
  await listener(payload(), async () => ({ kind: 'reject' }))
  assert.equal(ledger.entries().length, 0)
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
