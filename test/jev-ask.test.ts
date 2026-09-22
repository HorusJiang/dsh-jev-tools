/**
 * The `jev_ask` tool.
 *
 * The important property is that every failure is a *value*, not a throw: a
 * model that receives `{ ok: false, problem, hint }` can tell the user what to
 * fix, and the uncalibrated-probability caveat must travel with every success.
 *
 * The report follows the conversation's language, so these tests seed the
 * context cache to drive it deliberately rather than relying on a default.
 *
 * @module dsh-jev-tools/test/jev-ask
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createJevAskTool } from '../lib/tools/jev-ask.js'
import { resolveSettings } from '../lib/config.js'
import { createBudget } from '../lib/budget.js'
import { createMemoryLedger } from '../lib/ledger.js'
import { createContextCache, type ContextCache } from '../lib/context-cache.js'
import type { CredentialsService, ToolDefinitionLike } from '../lib/host.js'

const SETTINGS = resolveSettings(undefined)
const SIGNAL = new AbortController().signal
const EXEC = { signal: SIGNAL, agent: { id: 'agent-1' } }

const KEYED: CredentialsService = {
  resolve: async () => ({ value: 'sk-test', source: 'env' }),
  describe: async () => ({ configured: true, writable: true }),
}

/** A cache whose task reads as Chinese, so reports render in Chinese. */
function chineseCache (): ContextCache {
  const cache = createContextCache()
  cache.remember('agent-1', '帮我把这些用户反馈按主题分类')
  return cache
}

/** Build the tool with controllable dependencies. */
function harness (options: {
  key?: CredentialsService
  answers?: Record<string, unknown>
  settings?: typeof SETTINGS
  cache?: ContextCache
} = {}): {
  tool: ToolDefinitionLike
  ledger: ReturnType<typeof createMemoryLedger>
  calls: () => number
} {
  const ledger = createMemoryLedger()
  let calls = 0
  const tool = createJevAskTool({
    settings: () => options.settings ?? SETTINGS,
    credentials: () => options.key ?? KEYED,
    backendFor: () => ({
      id: 'fake',
      judge: async (request) => {
        calls += 1
        const answers: Record<string, unknown> = {}
        for (const id of Object.keys(request.questions)) {
          answers[id] = options.answers?.[id] ?? { type: 'noul', noul: 0.72 }
        }
        return {
          model: 'jev-1.13.0',
          requestedModel: 'jev-latest',
          answers: answers as never,
          usage: { inputTokens: 400, outputTokens: 0 },
        }
      },
    }),
    cache: options.cache ?? chineseCache(),
    budget: createBudget(3, 200),
    ledger,
    now: () => 5_000,
  })
  return { tool, ledger, calls: () => calls }
}

const ASK = {
  state: 'the ticket',
  questions: { refund: { type: 'noul', instructions: 'Is a refund requested?' } },
}

test('the tool declares the shape the registry expects', () => {
  const { tool } = harness()
  assert.equal(tool.name, 'jev_ask')
  assert.ok(tool.description.length > 40, 'the description teaches the model when to use it')
  assert.deepEqual(tool.parameters.required, ['state', 'questions'])
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.output.render, 'function')
})

test('a disabled plugin declines without any network call', async () => {
  const off = resolveSettings({ enabled: false })
  const { tool, calls } = harness({ settings: off })
  const result = await tool.execute(ASK, EXEC) as Record<string, unknown>
  assert.equal(result.ok, false)
  assert.equal(result.problem, 'disabled')
  assert.equal(calls(), 0)
})

test('malformed questions are refused before the content leaves the machine', async () => {
  const { tool, calls } = harness()
  const result = await tool.execute({ state: 'x', questions: 'not an object' }, EXEC) as Record<string, unknown>
  assert.equal(result.ok, false)
  assert.equal(result.problem, 'invalid-request')
  assert.equal(calls(), 0)
})

test('an unsendable question is refused, naming the violation', async () => {
  const { tool, calls } = harness()
  const result = await tool.execute({
    state: 'x',
    questions: { pick: { type: 'choice', instructions: 'x', criteria: {} } },
  }, EXEC) as Record<string, unknown>
  assert.equal(result.ok, false)
  assert.equal(result.problem, 'invalid-request')
  assert.match(String(result.detail), /choice/)
  assert.equal(calls(), 0)
})

test('a missing key declines and points at where to get one', async () => {
  const empty: CredentialsService = {
    resolve: async () => undefined,
    describe: async () => ({ configured: false, writable: true }),
  }
  const { tool, calls } = harness({ key: empty })
  const result = await tool.execute(ASK, EXEC) as Record<string, unknown>
  assert.equal(result.ok, false)
  assert.equal(result.problem, 'no-key')
  assert.match(String(result.hint), /console\.typesafe\.ai/)
  assert.equal(calls(), 0)
})

test('a successful call records the answering version and warns that probabilities are uncalibrated', async () => {
  const { tool, ledger } = harness()
  const result = await tool.execute(ASK, EXEC) as {
    ok: boolean, model: string, calibrated: boolean, report: string
  }
  assert.equal(result.ok, true)
  assert.equal(result.model, 'jev-1.13.0')
  assert.equal(result.calibrated, false)
  assert.match(result.report, /未经标定/)
  assert.match(result.report, /只用于排序/)
  // The alias that was asked for is reported alongside the version that answered.
  assert.match(result.report, /jev-latest/)
  assert.equal(ledger.entries().at(-1)?.model, 'jev-1.13.0')
})

test('the report follows the conversation language', async () => {
  const english = createContextCache()
  english.remember('agent-1', 'classify these support tickets by theme')
  const { tool } = harness({ cache: english })
  const result = await tool.execute(ASK, EXEC) as { report: string }
  // Same facts, English wording — no Chinese should leak into an English session.
  assert.match(result.report, /not calibrated/i)
  assert.match(result.report, /rank with them/i)
  assert.equal(/未经标定/.test(result.report), false)
})

test('a Noul answer is described without inventing a confidence', async () => {
  const { tool } = harness({ answers: { refund: { type: 'noul', noul: 0.22 } } })
  const result = await tool.execute(ASK, EXEC) as { report: string }
  assert.match(result.report, /0\.220/)
  assert.match(result.report, /无 confidence 字段/)
})

test('a Choice answer lists the whole distribution, not just the winner', async () => {
  const { tool } = harness({
    answers: { route: { type: 'choice', choice: 'billing', probabilities: { billing: 0.81, tech: 0.19 }, confidence: 0.81 } },
  })
  const result = await tool.execute({
    state: 'x',
    questions: { route: { type: 'choice', instructions: 'which team?', criteria: { billing: 'money', tech: 'bug' } } },
  }, EXEC) as { report: string }
  assert.match(result.report, /billing/)
  assert.match(result.report, /tech 0\.190/)
})

test('a question the backend never answered is reported rather than silently dropped', async () => {
  const tool = createJevAskTool({
    settings: () => SETTINGS,
    credentials: () => KEYED,
    backendFor: () => ({ id: 'fake', judge: async () => ({ model: 'jev-1.13.0', answers: { a: { type: 'noul', noul: 0.5 } } as never }) }),
    cache: chineseCache(),
    budget: createBudget(3, 200),
    ledger: createMemoryLedger(),
    now: () => 1,
  })
  const result = await tool.execute({
    state: 'x',
    questions: { a: { type: 'noul', instructions: 'a' }, b: { type: 'noul', instructions: 'b' } },
  }, EXEC) as { report: string }
  assert.match(result.report, /未返回答案：b/)
})

test('a transport failure declines instead of throwing', async () => {
  const tool = createJevAskTool({
    settings: () => SETTINGS,
    credentials: () => KEYED,
    backendFor: () => ({ id: 'fake', judge: async () => { throw new Error('ECONNREFUSED') } }),
    cache: chineseCache(),
    budget: createBudget(3, 200),
    ledger: createMemoryLedger(),
    now: () => 1,
  })
  const result = await tool.execute(ASK, EXEC) as Record<string, unknown>
  assert.equal(result.ok, false)
  assert.equal(result.problem, 'unknown')
})

test('the renderer survives a value it does not recognise', () => {
  const { tool } = harness()
  const blocks = tool.output.render(ASK, { ok: true }) as { type: string, text: string }[]
  assert.equal(blocks[0]?.type, 'text')
  assert.match(blocks[0]?.text ?? '', /no judgment/)
})

// ── quotas, and what a refusal looks like ───────────────────────────────────

test('more than three calls in one session still succeed', async () => {
  // The regression. `tryConsume(agentId, -1)` passed a pseudo-turn that never
  // advances, so a *per-turn* ceiling behaved as a session-long cap of three:
  // the fourth call onwards was refused with `budget-turn` for the rest of the
  // session. Measured 2026-09-22 against a live session, where `jev_ask` simply
  // stopped answering after three uses and reported only `(no judgment)`.
  const { tool, calls } = harness()
  for (let i = 1; i <= 6; i += 1) {
    const result = await tool.execute(ASK, EXEC) as Record<string, unknown>
    assert.equal(result.ok, true, `call ${i} must still be judged`)
  }
  assert.equal(calls(), 6)
})

test('the session ceiling still bounds explicit calls', async () => {
  const tool = createJevAskTool({
    settings: () => resolveSettings({ sessionCallLimit: 2 }),
    credentials: () => KEYED,
    backendFor: () => ({
      id: 'fake',
      judge: async () => ({ model: 'jev-1.13.0', answers: { refund: { type: 'noul', noul: 0.5 } } as never }),
    }),
    cache: chineseCache(),
    budget: createBudget(3, 2),
    ledger: createMemoryLedger(),
    now: () => 1,
  })
  const first = await tool.execute(ASK, EXEC) as Record<string, unknown>
  const second = await tool.execute(ASK, EXEC) as Record<string, unknown>
  const third = await tool.execute(ASK, EXEC) as Record<string, unknown>
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  // The session ceiling is the one that actually applies to an explicit call.
  assert.equal(third.ok, false)
  assert.equal(third.problem, 'budget-session')
  assert.match(String(third.detail), /at most 2/)
})

test('a decline renders its reason rather than an opaque placeholder', async () => {
  // The renderer reads only `report`, and a decline used to carry just
  // `message`/`detail` — so a missing key, an invalid request and an exhausted
  // quota all showed up as `(no judgment)` in the one place the README says
  // these failures are visible.
  const missing: CredentialsService = {
    resolve: async () => undefined,
    describe: async () => ({ configured: false, writable: true }),
  }
  const { tool } = harness({ key: missing })
  const result = await tool.execute(ASK, EXEC)
  const blocks = tool.output.render(ASK, result) as { text: string }[]
  const text = blocks[0]?.text ?? ''
  assert.equal(/no judgment/.test(text), false)
  assert.match(text, /TYPESAFE_API_KEY/)
})

test('a decline is recorded against the calling agent', async () => {
  // The row hardcoded an empty agentId while the success path recorded the real
  // one, so half of a tool's ledger could not be attributed to a session.
  const missing: CredentialsService = {
    resolve: async () => undefined,
    describe: async () => ({ configured: false, writable: true }),
  }
  const { tool, ledger } = harness({ key: missing })
  await tool.execute(ASK, EXEC)
  const record = ledger.entries().at(-1)
  assert.equal(record?.feature, 'tool')
  assert.equal(record?.outcome, 'skipped')
  assert.equal(record?.agentId, 'agent-1')
})
