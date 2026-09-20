/**
 * Pruning: chunk selection, reassembly, and the listener's failure behaviour.
 *
 * The load-bearing assertions are the negative ones. Pruning is an
 * optimisation, so every unexpected path must return the payload untouched and
 * every guard must avoid the network call entirely.
 *
 * @module dsh-jev-tools/test/prune
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { chunkText, createPruneListener, reassemble, selectChunks } from '../lib/features/prune.js'
import { resolveSettings } from '../lib/config.js'
import { createBudget } from '../lib/budget.js'
import { createContextCache } from '../lib/context-cache.js'
import { createMemoryLedger } from '../lib/ledger.js'
import { createMemo } from '../lib/memo.js'
import type { CredentialsService, PostToolDecision } from '../lib/host.js'

const SETTINGS = resolveSettings(undefined)

/**
 * A paragraph of roughly `tokens` estimated tokens, across several lines.
 *
 * Multi-line on purpose: the head/tail floors are configured in lines, so a
 * one-line payload would exercise a shape real tool output rarely has.
 */
function paragraph (label: string, tokens: number): string {
  const perLine = Math.max(8, tokens)
  const body = Array.from({ length: 4 }, () => 'x'.repeat(perLine))
  return [label, ...body].join('\n')
}

/** A payload of `count` chunks. */
function payload (count: number, tokensEach = 300): string {
  return Array.from({ length: count }, (_, i) => paragraph(`seg${i}`, tokensEach)).join('\n\n')
}

/** A credentials service that always resolves. */
const KEYED: CredentialsService = {
  resolve: async () => ({ value: 'sk-test', source: 'env' }),
  describe: async () => ({ configured: true, writable: true }),
}

const EMPTY: CredentialsService = {
  resolve: async () => undefined,
  describe: async () => ({ configured: false, writable: true }),
}

/** Build a listener plus the handles a test needs to inspect. */
function harness (options: {
  key?: CredentialsService
  relevance?: number[]
  /** Indices whose answer never arrives, as in a truncated response. */
  missing?: number[]
  /** Indices that come back as an answer type this client cannot read. */
  unknown?: number[]
  /** Raw settings overrides, resolved through the schema. */
  config?: unknown
} = {}) {
  const cache = createContextCache()
  const ledger = createMemoryLedger()
  const judgeCalls: unknown[] = []
  // A holder rather than a constant, so a test can change settings between
  // calls — which is the only way to prove that a mode does not leak state.
  const holder = { value: resolveSettings(options.config) }
  const listener = createPruneListener({
    settings: () => holder.value,
    credentials: () => options.key ?? KEYED,
    backendFor: () => ({
      id: 'fake',
      judge: async (request) => {
        judgeCalls.push(request)
        const ids = Object.keys(request.questions)
        const answers: Record<string, unknown> = {}
        ids.forEach((id, index) => {
          if (options.missing?.includes(index) === true) return
          if (options.unknown?.includes(index) === true) {
            answers[id] = { type: 'a_newer_primitive', noul: 1 }
            return
          }
          answers[id] = { type: 'noul', noul: options.relevance?.[index] ?? 0 }
        })
        return { model: 'jev-1.13.0', requestedModel: 'jev-latest', answers: answers as never }
      },
    }),
    pruner: () => undefined,
    cache,
    budget: createBudget(holder.value.prune.perTurnLimit, holder.value.sessionCallLimit),
    memo: createMemo(),
    ledger,
    now: () => 1_000,
    newMessageId: () => 'notice-1',
  })
  return { listener, cache, ledger, judgeCalls, holder }
}

const EXEC = {
  name: 'read',
  arguments: { file_path: 'a.ts' },
  callId: 'c1',
  agent: { id: 'agent-1' },
  signal: new AbortController().signal,
}

const accept = async (): Promise<PostToolDecision> => ({ kind: 'accept' })

// ── chunking and selection ──────────────────────────────────────────────────

test('chunkText splits on blank lines and keeps order', () => {
  const chunks = chunkText('first\n\nsecond\n\nthird')
  assert.deepEqual(chunks.map(c => c.text.trim()), ['first', 'second', 'third'])
})

test('chunkText splits an oversized paragraph rather than emitting one huge chunk', () => {
  const huge = Array.from({ length: 60 }, (_, i) => `line ${i} ${'y'.repeat(80)}`).join('\n')
  const chunks = chunkText(huge)
  assert.ok(chunks.length > 1, 'a big paragraph must be split')
  for (const chunk of chunks) assert.ok(chunk.tokens <= 500, `chunk too large: ${chunk.tokens}`)
})

test('selection always keeps the head and the tail', () => {
  const chunks = chunkText(payload(30))
  // Nothing is relevant.
  const { keep } = selectChunks(chunks, chunks.map(() => 0), SETTINGS.prune)
  // 40 head lines and 40 tail lines, at ~1 line per paragraph here.
  assert.equal(keep[0], true, 'the first chunk must survive')
  assert.equal(keep[chunks.length - 1], true, 'the last chunk must survive')
})

test('a confident chunk is kept even when it is not at either end', () => {
  const chunks = chunkText(payload(30))
  const relevance = chunks.map(() => 0)
  relevance[5] = 0.9 // at or above keepHigh
  const { keep } = selectChunks(chunks, relevance, SETTINGS.prune)
  assert.equal(keep[5], true)
})

test('the result never falls below the keep floor', () => {
  const chunks = chunkText(payload(20))
  const original = chunks.reduce((sum, c) => sum + c.tokens, 0)
  const { keptTokens } = selectChunks(chunks, chunks.map(() => 0), SETTINGS.prune)
  assert.ok(keptTokens >= original * SETTINGS.prune.minKeepRatio, `${keptTokens} < ${original * 0.2}`)
})

test('reassembly preserves original order and marks what was dropped', () => {
  const chunks = chunkText('a\n\nb\n\nc\n\nd')
  const text = reassemble(chunks, [true, false, false, true], [], 'zh')
  const order = ['a', 'd'].map(marker => text.indexOf(marker))
  assert.ok(order[0]! < order[1]!, 'kept chunks must stay in the original order')
  assert.match(text, /已省略 2 段/)
})

// ── the listener's guards ───────────────────────────────────────────────────

test('a tool outside the allowlist is never judged', async () => {
  const { listener, cache, judgeCalls } = harness()
  cache.remember('agent-1', 'do the thing')
  const decision = await listener({ ...EXEC, name: 'bash' }, { isError: false, content: [] }, accept)
  assert.deepEqual(decision, { kind: 'accept' })
  assert.equal(judgeCalls.length, 0)
})

test('an error result is never rewritten', async () => {
  const { listener, cache, judgeCalls } = harness()
  cache.remember('agent-1', 'do the thing')
  await listener(EXEC, { isError: true, content: [{ type: 'text', text: payload(30) }] }, accept)
  assert.equal(judgeCalls.length, 0)
})

test('a blocked call is passed through untouched and never judged', async () => {
  const { listener, cache, judgeCalls } = harness()
  cache.remember('agent-1', 'do the thing')
  const blocked: PostToolDecision = { kind: 'block', feedback: [{ type: 'text', text: 'no' }] }
  const decision = await listener(EXEC, { isError: false, content: [{ type: 'text', text: payload(30) }] }, async () => blocked)
  assert.deepEqual(decision, blocked)
  assert.equal(judgeCalls.length, 0)
})

test('without a resolved key nothing is judged and the skip is recorded', async () => {
  const { listener, cache, ledger, judgeCalls } = harness({ key: EMPTY })
  cache.remember('agent-1', 'do the thing')
  const decision = await listener(EXEC, { isError: false, content: [{ type: 'text', text: payload(30) }] }, accept)
  assert.deepEqual(decision, { kind: 'accept' })
  assert.equal(judgeCalls.length, 0)
  assert.equal(ledger.entries().at(-1)?.skip, 'no-key')
})

test('without a known task relevance is undecidable, so nothing is sent', async () => {
  const { listener, ledger, judgeCalls } = harness()
  const decision = await listener(EXEC, { isError: false, content: [{ type: 'text', text: payload(30) }] }, accept)
  assert.deepEqual(decision, { kind: 'accept' })
  assert.equal(judgeCalls.length, 0)
  assert.equal(ledger.entries().at(-1)?.skip, 'no-task')
})

test('a payload below the size floor is skipped', async () => {
  const { listener, cache, ledger, judgeCalls } = harness()
  cache.remember('agent-1', 'do the thing')
  await listener(EXEC, { isError: false, content: [{ type: 'text', text: 'short' }] }, accept)
  assert.equal(judgeCalls.length, 0)
  assert.equal(ledger.entries().at(-1)?.skip, 'too-small')
})

// ── the happy path and the notice ───────────────────────────────────────────

test('an oversized result is pruned, a notice is attached, and non-text blocks survive', async () => {
  const { listener, cache, ledger, judgeCalls } = harness({ relevance: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] })
  cache.remember('agent-1', 'fix the parser bug')
  const image = { type: 'image', attachment: { attachmentId: 'a' } }
  const content = [{ type: 'text', text: payload(30) }, image]

  const decision = await listener(EXEC, { isError: false, content }, accept)

  assert.equal(judgeCalls.length, 1, 'exactly one request carries every question')
  assert.equal(decision.kind, 'accept')
  if (decision.kind !== 'accept') return

  const blocks = decision.content as { type: string }[]
  assert.ok(blocks.some(b => b.type === 'image'), 'an image block must be carried through')
  assert.equal(blocks.filter(b => b.type === 'text').length, 1, 'text blocks collapse into one')

  const contexts = decision.additionalContexts as { source?: { form?: string, summary?: string } }[]
  assert.equal(contexts?.length, 1)
  assert.equal(contexts[0]?.source?.form, 'notice')
  assert.match(contexts[0]?.source?.summary ?? '', /→/)

  const record = ledger.entries().at(-1)
  assert.equal(record?.outcome, 'judged')
  assert.equal(record?.feature, 'prune')
  assert.equal(record?.model, 'jev-1.13.0', 'the answering version is recorded, not the alias')
  assert.ok((record?.keptTokens ?? 0) < (record?.originalTokens ?? 0))
})

test('an unreadable answer fails open instead of being read as "not relevant"', async () => {
  // Regression. A missing or wrong-typed answer used to fall back to 0, which is
  // a *confident* "not relevant": a truncated response would then have removed
  // that segment, biased the whole selection toward deleting more, and still
  // recorded the judgment as `judged`. The ecosystem names this exact mistake —
  // "sorting a missing score as a confident zero".
  const irrelevant = Array.from({ length: 30 }, () => 0)
  const { listener, cache, ledger, judgeCalls } = harness({ relevance: irrelevant, missing: [3] })
  cache.remember('agent-1', 'fix the parser bug')
  const content = [{ type: 'text', text: payload(30) }]

  const decision = await listener(EXEC, { isError: false, content }, accept)

  assert.equal(judgeCalls.length, 1, 'the request still goes out')
  assert.deepEqual(decision, { kind: 'accept' }, 'the payload must pass through untouched')
  const record = ledger.entries().at(-1)
  assert.equal(record?.skip, 'malformed-response')
  assert.equal(record?.outcome, 'skipped', 'the ledger must not claim this judgment happened')
})

test('a wrong-typed answer fails open too, and one is enough for the whole payload', async () => {
  // The dangerous case is a *partially* usable response: the readable answers
  // would happily prune while the unreadable one silently loses its segment.
  const irrelevant = Array.from({ length: 30 }, () => 0)
  const { listener, cache, ledger } = harness({ relevance: irrelevant, unknown: [0] })
  cache.remember('agent-1', 'fix the parser bug')
  const content = [{ type: 'text', text: payload(30) }]

  const decision = await listener(EXEC, { isError: false, content }, accept)

  assert.deepEqual(decision, { kind: 'accept' })
  assert.equal(ledger.entries().at(-1)?.skip, 'malformed-response')
})

test('a fully readable response is still pruned, so the guard is not over-eager', async () => {
  // The counterfactual: identical input and identical answers, with the answers
  // actually present. This must prune, or the guard would have disabled the
  // feature rather than fixed it.
  const irrelevant = Array.from({ length: 30 }, () => 0)
  const { listener, cache, ledger } = harness({ relevance: irrelevant })
  cache.remember('agent-1', 'fix the parser bug')
  const content = [{ type: 'text', text: payload(30) }]

  const decision = await listener(EXEC, { isError: false, content }, accept)

  assert.equal(decision.kind, 'accept')
  assert.equal(ledger.entries().at(-1)?.outcome, 'judged')
  assert.ok((ledger.entries().at(-1)?.keptTokens ?? 0) < (ledger.entries().at(-1)?.originalTokens ?? 0))
})

// ── shadow mode ─────────────────────────────────────────────────────────────

test('shadow mode reports what it would have done and changes nothing', async () => {
  const irrelevant = Array.from({ length: 30 }, () => 0)
  const { listener, cache, ledger } = harness({ relevance: irrelevant, config: { prune: { shadow: true } } })
  cache.remember('agent-1', 'fix the parser bug')
  const content = [{ type: 'text', text: payload(30) }]

  const decision = await listener(EXEC, { isError: false, content }, accept)

  assert.equal(decision.kind, 'accept')
  if (decision.kind !== 'accept') return
  assert.deepEqual(decision.content, content, 'shadow mode must not touch the content')

  const notice = decision.additionalContexts?.[0] as { source?: { summary?: string }, content?: { text: string }[] }
  assert.match(String(notice?.source?.summary), /^shadow · /)
  assert.match(String(notice?.content?.[0]?.text), /shadow mode/i)

  // The measurement is real — the request went out and was paid for — so it is
  // recorded, with the numbers, as a skip rather than as a saving.
  const record = ledger.entries().at(-1)
  assert.equal(record?.outcome, 'skipped')
  assert.equal(record?.skip, 'shadow')
  assert.ok((record?.keptTokens ?? 0) < (record?.originalTokens ?? 0), 'the hypothetical is recorded')
})

test('shadow mode never inflates the saved-token totals', async () => {
  // The ledger's token totals mean "removed from the context". In shadow mode
  // nothing was removed, so counting it would make the plugin's headline number
  // a description of work it did not do.
  const irrelevant = Array.from({ length: 30 }, () => 0)
  const { listener, cache, ledger } = harness({ relevance: irrelevant, config: { prune: { shadow: true } } })
  cache.remember('agent-1', 'fix the parser bug')
  await listener(EXEC, { isError: false, content: [{ type: 'text', text: payload(30) }] }, accept)

  assert.equal(ledger.summary().savedTokens, 0)
  assert.equal(ledger.summary().skipped, 1)
  assert.equal(ledger.summary().judged, 0)
})

test('shadow mode does not poison the memo with content it never applied', async () => {
  const irrelevant = Array.from({ length: 30 }, () => 0)
  const { listener, cache, ledger, judgeCalls, holder } = harness({ relevance: irrelevant })
  cache.remember('agent-1', 'fix the parser bug')
  const content = [{ type: 'text', text: payload(30) }]

  holder.value = resolveSettings({ prune: { shadow: true } })
  const shadowed = await listener(EXEC, { isError: false, content }, accept)
  assert.deepEqual(shadowed.content, content)

  // Leaving shadow mode must actually apply from here on. If the shadow run had
  // memoized its result, this call would be served rewritten content it never
  // agreed to — silently, because a memo hit sends no request.
  holder.value = resolveSettings(undefined)
  const applied = await listener(EXEC, { isError: false, content }, accept)
  assert.equal(judgeCalls.length, 2, 'the shadow run must not have memoized')
  assert.notDeepEqual(applied.content, content, 'the second call must really prune')
  assert.equal(ledger.entries().at(-1)?.outcome, 'judged')
})

test('an identical payload is judged once, then served from the memo', async () => {
  const { listener, cache, judgeCalls } = harness()
  cache.remember('agent-1', 'fix the parser bug')
  const content = [{ type: 'text', text: payload(30) }]
  await listener(EXEC, { isError: false, content }, accept)
  await listener(EXEC, { isError: false, content }, accept)
  assert.equal(judgeCalls.length, 1, 'the second identical call must not reach the network')
})

test('per-turn quota stops further judgments in the same turn', async () => {
  const { listener, cache, ledger, judgeCalls } = harness()
  cache.remember('agent-1', 'fix the parser bug')
  cache.rememberTurn('agent-1', 1)
  // The default per-turn ceiling is 3. Each payload differs in size, so the
  // memo cannot absorb any of them and every call reaches the quota check.
  for (let i = 0; i < 4; i += 1) {
    const content = [{ type: 'text', text: payload(30 + i * 5) }]
    await listener(EXEC, { isError: false, content }, accept)
  }
  assert.equal(judgeCalls.length, SETTINGS.prune.perTurnLimit)
  assert.equal(ledger.entries().at(-1)?.skip, 'budget-turn')
})

test('two payloads of equal length but different content are not confused', async () => {
  // Regression: the key once hashed only token counts, which are character
  // counts — so an edit that preserved a file's length would have been served
  // the previous pruning.
  const { listener, cache, judgeCalls } = harness()
  cache.remember('agent-1', 'fix the parser bug')
  const sameLength = (filler: string): string =>
    Array.from({ length: 20 }, (_, i) => paragraph(`seg${i}`, 300).replaceAll('x', filler)).join('\n\n')
  await listener(EXEC, { isError: false, content: [{ type: 'text', text: sameLength('a') }] }, accept)
  await listener(EXEC, { isError: false, content: [{ type: 'text', text: sameLength('b') }] }, accept)
  assert.equal(judgeCalls.length, 2, 'different content must be judged separately')
})

test('a backend failure degrades to the original payload', async () => {
  const cache = createContextCache()
  cache.remember('agent-1', 'fix the parser bug')
  const listener = createPruneListener({
    settings: () => SETTINGS,
    credentials: () => KEYED,
    backendFor: () => ({ id: 'fake', judge: async () => { throw new Error('network down') } }),
    pruner: () => undefined,
    cache,
    budget: createBudget(3, 200),
    memo: createMemo(),
    ledger: createMemoryLedger(),
    now: () => 1_000,
    newMessageId: () => 'n',
  })
  const decision = await listener(EXEC, { isError: false, content: [{ type: 'text', text: payload(30) }] }, accept)
  assert.deepEqual(decision, { kind: 'accept' })
})

// ── task-text guards ────────────────────────────────────────────────────────

test('a terse request is not used to judge relevance', async () => {
  // Regression from live use: the task was a two-character follow-up, and the
  // resulting 8/13 selection was arbitrary. A payload must be left alone
  // rather than cut against a request that says nothing.
  const { listener, cache, ledger, judgeCalls } = harness()
  cache.remember('agent-1', '继续吧')
  const decision = await listener(EXEC, { isError: false, content: [{ type: 'text', text: payload(30) }] }, accept)
  assert.deepEqual(decision, { kind: 'accept' })
  assert.equal(judgeCalls.length, 0)
  assert.equal(ledger.entries().at(-1)?.skip, 'task-too-vague')
})

test('several recent messages together form an adequate task', () => {
  // One short message is not enough; the conversation before it often is.
  const cache = createContextCache()
  cache.remember('agent-1', '我在改 dsh-jev-tools 这个 DSH 插件')
  cache.remember('agent-1', '继续吧')
  const task = cache.task('agent-1')
  assert.ok(task !== undefined)
  assert.ok(task.length >= SETTINGS.prune.minTaskChars)
  assert.match(task, /dsh-jev-tools/)
  assert.match(task, /继续吧/)
})

test('a repeated message does not crowd the task description', () => {
  const cache = createContextCache()
  cache.remember('agent-1', 'fix the parser bug')
  cache.remember('agent-1', 'fix the parser bug')
  assert.equal(cache.task('agent-1'), 'fix the parser bug')
})

test('only the most recent few messages are kept', () => {
  const cache = createContextCache()
  for (const text of ['one two three', 'four five six', 'seven eight nine', 'ten eleven twelve']) {
    cache.remember('agent-1', text)
  }
  const task = cache.task('agent-1') ?? ''
  // The oldest has been dropped, the newest is present.
  assert.equal(task.includes('one two three'), false)
  assert.match(task, /ten eleven twelve/)
})

test('forgetting an agent clears both its task and its turn', () => {
  const cache = createContextCache()
  cache.remember('agent-1', 'fix the parser bug')
  cache.rememberTurn('agent-1', 4)
  cache.forget('agent-1')
  assert.equal(cache.task('agent-1'), undefined)
  assert.equal(cache.turn('agent-1'), undefined)
})
