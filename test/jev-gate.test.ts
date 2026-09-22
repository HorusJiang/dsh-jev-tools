/**
 * The completion gate.
 *
 * The point of this file is the decision matrix, and in particular the
 * direction every unclear path resolves. Every other capability in this plugin
 * fails *open* — it does nothing. A gate cannot: failing open here would mean
 * failing to "approved", so each ambiguous case must come back `escalate`.
 *
 * @module dsh-jev-tools/test/jev-gate
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createJevGateTool } from '../lib/tools/jev-gate.js'
import { resolveSettings } from '../lib/config.js'
import { createBudget } from '../lib/budget.js'
import { createContextCache } from '../lib/context-cache.js'
import { createMemoryLedger } from '../lib/ledger.js'
import type { CredentialsService, ToolDefinitionLike } from '../lib/host.js'

const KEYED: CredentialsService = {
  resolve: async () => ({ value: 'sk-test', source: 'env' }),
  describe: async () => ({ configured: true, writable: true }),
}

/** Answers, keyed by question id. Anything absent simply does not arrive. */
type Answers = Record<string, unknown>

/** Build the tool over a backend that answers from `answers`. */
function harness (options: { answers?: Answers, throwOnJudge?: boolean, key?: CredentialsService } = {}) {
  const ledger = createMemoryLedger()
  const requests: { questions: Record<string, unknown>, state: unknown }[] = []
  const cache = createContextCache()
  cache.remember('agent-1', 'check the delivery')
  const settings = resolveSettings(undefined)
  const tool: ToolDefinitionLike = createJevGateTool({
    settings: () => settings,
    credentials: () => options.key ?? KEYED,
    backendFor: () => ({
      id: 'fake',
      judge: async (request) => {
        if (options.throwOnJudge === true) throw new Error('backend down')
        requests.push(request as { questions: Record<string, unknown>, state: unknown })
        const answers: Answers = {}
        for (const id of Object.keys(request.questions)) {
          const answer = options.answers?.[id]
          if (answer !== undefined) answers[id] = answer
        }
        return {
          model: 'jev-1.13.0', requestedModel: 'jev-latest',
          answers: answers as never, usage: { inputTokens: 700, outputTokens: 0 },
        }
      },
    }),
    cache,
    budget: createBudget(3, 200),
    ledger,
    now: () => 1_000,
  })
  return { tool, ledger, requests }
}

/** Call the tool the way the harness would. */
async function gate (tool: ToolDefinitionLike, args: unknown, agentId = 'agent-1') {
  return await tool.execute(args, {
    signal: new AbortController().signal,
    agent: { id: agentId },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as never) as Record<string, unknown>
}

/** A choice answer. */
const verified = (confidence = 0.95) => ({ type: 'choice', choice: 'verified', probabilities: {}, confidence })
const contradicted = (confidence = 0.95) => ({ type: 'choice', choice: 'contradicted', probabilities: {}, confidence })
const notAddressed = (confidence = 0.9) => ({ type: 'choice', choice: 'not_addressed', probabilities: {}, confidence })
const meets = (noul: number) => ({ type: 'noul', noul })

const REQUEST = {
  request: 'Make the parser tolerate an empty document.',
  claims: ['The empty-input test passes.', 'Whitespace-only input is handled.'],
  evidence: 'node --test: 2 passed, 1 failing (parse: invalid JSON still rejects)',
}

// ── the happy path ──────────────────────────────────────────────────────────

test('every claim verified at high confidence is the only route to auto', async () => {
  const { tool, requests } = harness({ answers: { c0: verified(1), c1: verified(0.99) } })
  const result = await gate(tool, REQUEST)

  assert.equal(result.ok, true)
  assert.equal(result.action, 'auto')
  assert.deepEqual(result.reasonCodes, ['accepted'])
  // One request, one question per claim, each self-describing in instructions.
  assert.equal(Object.keys(requests[0]!.questions).length, 2)
  assert.match(JSON.stringify(requests[0]!.questions['c0']), /claims\.c0/)
})

test('an artifact is judged against the request when one is supplied', async () => {
  const { tool, requests } = harness({ answers: { c0: verified(1), artifact: meets(0.97) } })
  const result = await gate(tool, { ...REQUEST, claims: [REQUEST.claims[0]!], artifact: 'diff --git a/src/parse.ts' })

  assert.equal(Object.keys(requests[0]!.questions).includes('artifact'), true)
  assert.equal(result.action, 'auto')
  assert.deepEqual(result.artifact, { probability: 0.97, action: 'auto' })
})

test('no artifact means no artifact question is asked at all', async () => {
  const { tool, requests } = harness({ answers: { c0: verified(1), c1: verified(1) } })
  await gate(tool, REQUEST)
  assert.equal(Object.keys(requests[0]!.questions).includes('artifact'), false)
})

// ── the findings the tool exists for ────────────────────────────────────────

test('a contradicted claim escalates', async () => {
  const { tool } = harness({ answers: { c0: verified(1), c1: contradicted(1) } })
  const result = await gate(tool, REQUEST)

  assert.equal(result.action, 'escalate')
  assert.ok((result.reasonCodes as string[]).includes('claims_contradicted'))
  const claim = (result.claims as { id: string, verdict: string, action: string }[])[1]!
  assert.equal(claim.verdict, 'contradicted')
  assert.equal(claim.action, 'escalate')
})

test('a claim the evidence does not address comes back review, not verified', async () => {
  const { tool } = harness({ answers: { c0: verified(1), c1: notAddressed(0.9) } })
  const result = await gate(tool, REQUEST)

  assert.equal(result.action, 'review')
  assert.ok((result.reasonCodes as string[]).includes('claims_not_addressed'))
})

test('a verified claim below the auto-accept confidence is only a review', async () => {
  const { tool } = harness({ answers: { c0: verified(1), c1: verified(0.55) } })
  const result = await gate(tool, REQUEST)

  assert.equal(result.action, 'review')
  assert.ok((result.reasonCodes as string[]).includes('claim_confidence_low'))
})

test('a hesitant contradiction is still not allowed to pass', async () => {
  // The one asymmetry: being unsure about a contradiction cannot buy silence.
  const { tool } = harness({ answers: { c0: verified(1), c1: contradicted(0.2) } })
  const result = await gate(tool, REQUEST)
  assert.notEqual(result.action, 'auto')
})

// ── where this inverts the plugin's own rule ────────────────────────────────

test('an unreadable claim answer escalates rather than being skipped', async () => {
  // "Could not tell" and "the evidence supports it" are different facts. An
  // unknown confidence must never be able to *satisfy* a threshold.
  const { tool } = harness({ answers: { c0: verified(1) } })   // c1 never arrives
  const result = await gate(tool, REQUEST)

  assert.equal(result.ok, true, 'the verdict is still produced')
  assert.equal(result.action, 'escalate')
  assert.ok((result.reasonCodes as string[]).includes('claims_unreadable'))
  const claim = (result.claims as { id: string, verdict: string, action: string }[])[1]!
  assert.equal(claim.verdict, 'unknown')
  assert.equal(claim.action, 'escalate')
})

test('a claim answered with an unreadable type escalates too', async () => {
  const { tool } = harness({ answers: { c0: { type: 'a_newer_primitive' }, c1: verified(1) } })
  const result = await gate(tool, REQUEST)
  assert.equal(result.action, 'escalate')
})

test('an unreadable artifact answer escalates', async () => {
  const { tool } = harness({ answers: { c0: verified(1) } })
  const result = await gate(tool, { request: REQUEST.request, claims: [REQUEST.claims[0]!], artifact: 'a diff' })
  assert.equal(result.action, 'escalate')
  assert.deepEqual(result.artifact, { probability: 0, action: 'escalate' })
})

test('truncated input can never be auto', async () => {
  // If the best evidence is the part that was cut, a confident `auto` would be
  // a statement about text the model never saw.
  const { tool } = harness({ answers: { c0: verified(1) } })
  const result = await gate(tool, {
    request: REQUEST.request,
    claims: [REQUEST.claims[0]!],
    evidence: 'x'.repeat(20_000),
  })

  assert.equal(result.truncated, true)
  assert.equal(result.action, 'escalate')
  assert.ok((result.reasonCodes as string[]).includes('input_truncated'))
})

test('a backend failure escalates, and says nothing was verified', async () => {
  const { tool } = harness({ throwOnJudge: true, answers: {} })
  const result = await gate(tool, REQUEST)

  assert.equal(result.ok, false)
  assert.equal(result.action, 'escalate', 'a gate that fails open to "approved" is not a gate')
  assert.equal(result.problem, 'unknown')
})

test('a missing key escalates and explains itself', async () => {
  const { tool } = harness({ key: { resolve: async () => undefined, describe: async () => ({ configured: false, writable: true }) } })
  const result = await gate(tool, REQUEST)

  assert.equal(result.ok, false)
  assert.equal(result.action, 'escalate')
  assert.equal(result.problem, 'no-key')
  assert.match(String(result.hint), /console\.typesafe\.ai/)
})

test('a disabled plugin escalates rather than silently approving', async () => {
  const { tool } = harness({ answers: { c0: verified(1), c1: verified(1) } })
  // The master switch lives in settings; rebuild with it off.
  const off = createJevGateTool({
    settings: () => resolveSettings({ enabled: false }),
    credentials: () => KEYED,
    backendFor: () => ({ id: 'fake', judge: async () => { throw new Error('must not be called') } }),
    cache: createContextCache(),
    budget: createBudget(3, 200),
    ledger: createMemoryLedger(),
    now: () => 1_000,
  })
  const result = await gate(off, REQUEST)
  assert.equal(result.action, 'escalate')
  assert.equal(result.problem, 'disabled')
  // And the enabled one still works, so the assertion above is about settings.
  assert.equal((await gate(tool, REQUEST)).action, 'auto')
})

// ── refusals ────────────────────────────────────────────────────────────────

test('a malformed call is refused instead of judged', async () => {
  const { tool, requests } = harness({ answers: {} })
  for (const args of [
    {},
    { request: '', claims: ['x'] },
    { request: 'do it', claims: [] },
    { request: 'do it', claims: [''] },
    { request: 'do it', claims: [1, 2] },
  ]) {
    const result = await gate(tool, args)
    assert.equal(result.ok, false, `${JSON.stringify(args)} should be refused`)
    assert.equal(result.action, 'escalate')
    assert.equal(result.problem, 'invalid-request')
  }
  assert.equal(requests.length, 0, 'a refused call must not reach the network')
})

test('too many claims is refused rather than silently checking a subset', async () => {
  // A gate that quietly drops claims reports on a delivery it did not fully see.
  const { tool, requests } = harness({ answers: {} })
  const result = await gate(tool, {
    request: 'do it',
    claims: Array.from({ length: 17 }, (_, i) => `claim ${i}`),
  })
  assert.equal(result.problem, 'invalid-request')
  assert.match(String(result.detail), /17/)
  assert.equal(requests.length, 0)
})

test('no evidence means every claim can only come back not_addressed', async () => {
  const { tool, requests } = harness({ answers: { c0: notAddressed(1), c1: notAddressed(1) } })
  const result = await gate(tool, { request: REQUEST.request, claims: REQUEST.claims })

  // The instruction still tells the model to answer from evidence only.
  assert.match(JSON.stringify(requests[0]!.questions['c0']), /evidence/)
  assert.equal(result.action, 'review')
  assert.match(String(result.report), /not_addressed/)
})

test('the report is rendered in the conversation\u2019s language', async () => {
  const cache = createContextCache()
  cache.remember('zh', '检查这次交付')
  const zh = createJevGateTool({
    settings: () => resolveSettings(undefined),
    credentials: () => KEYED,
    backendFor: () => ({
      id: 'fake',
      judge: async () => ({
        model: 'jev-1.13.0', answers: { c0: verified(1) } as never,
        usage: { inputTokens: 10, outputTokens: 0 },
      }),
    }),
    cache, budget: createBudget(3, 200), ledger: createMemoryLedger(), now: () => 1_000,
  })
  const result = await gate(zh, { request: '让解析器容忍空文档', claims: ['空输入测试通过'] }, 'zh')
  assert.match(String(result.report), /Jev 闸门/)
  // The report names claims by the id the caller chose; the caller already has
  // the text, and repeating it would double the report's size for no gain.
  assert.match(String(result.report), /c0 verified/)
  assert.match(String(result.report), /未提供 evidence/)
})

// ── quotas, and what a refusal looks like ───────────────────────────────────

test('more than three calls in one session still succeed', async () => {
  // Same regression as `jev_ask`: `tryConsume(agentId, -1)` used a pseudo-turn
  // that never advances, turning a per-turn ceiling into a session-long cap of
  // three. A gate that silently stops working is worse than a gate that is
  // absent, because its silence reads as approval.
  const { tool } = harness({ answers: { c0: verified(1), c1: verified(1) } })
  for (let i = 1; i <= 6; i += 1) {
    const result = await gate(tool, REQUEST)
    assert.equal(result.ok, true, `call ${i} must still be judged`)
  }
})

test('a refusal renders its reason rather than an opaque placeholder', async () => {
  // The renderer reads only `report`; a decline used to carry just
  // `message`/`detail`, so every refusal displayed as `(no gate verdict)` — and
  // a refusal here means "unverified", which must not be silent.
  const missing: CredentialsService = {
    resolve: async () => undefined,
    describe: async () => ({ configured: false, writable: true }),
  }
  const { tool } = harness({ key: missing })
  const result = await gate(tool, REQUEST)
  const blocks = tool.output.render(REQUEST, result) as { text: string }[]
  const text = blocks[0]?.text ?? ''
  assert.equal(/no gate verdict/.test(text), false)
  assert.equal(result.action, 'escalate')
  assert.match(text, /TYPESAFE_API_KEY/)
})

test('a refusal is recorded against the calling agent', async () => {
  const missing: CredentialsService = {
    resolve: async () => undefined,
    describe: async () => ({ configured: false, writable: true }),
  }
  const { tool, ledger } = harness({ key: missing })
  await gate(tool, REQUEST)
  const record = ledger.entries().at(-1)
  assert.equal(record?.feature, 'tool')
  assert.equal(record?.outcome, 'skipped')
  assert.equal(record?.agentId, 'agent-1')
})
