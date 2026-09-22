/**
 * The composition root's wiring.
 *
 * `apply` is the one place where a setting stops being a value and becomes the
 * address a request is actually sent to. No unit test of a single module sees
 * that seam: the schema test and the backend test both stay green while nothing
 * forwards one to the other, which is exactly the defect a user hits when a key
 * scoped to another System One host 401s and fail-open hides it.
 *
 * So the seam is exercised here — against a fake context, through the real
 * `jev_ask` tool, with `fetch` replaced by a recorder.
 *
 * @module dsh-jev-tools/test/index
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply } from '../lib/index.js'
import type { CredentialsService, PluginContext, ServiceScope, ToolDefinitionLike } from '../lib/host.js'

const KEYED: CredentialsService = {
  resolve: async () => ({ value: 'sk-test', source: 'env' }),
  describe: async () => ({ configured: true, writable: true }),
}

/** A context that serves only what a test supplies, like a profile missing the rest. */
function context (services: ServiceScope): PluginContext {
  return {
    inject (names, callback) {
      const scope: Record<string, unknown> = {}
      for (const name of names) {
        // Cordis waits for every named service, so one absence means "not yet".
        if (services[name] === undefined) return
        scope[name] = services[name]
      }
      callback(scope as ServiceScope)
    },
    effect () {},
    on () { return () => {} },
  }
}

/** Mount the plugin on one entry and hand back the `jev_ask` tool it registered. */
function mount (entry: unknown): ToolDefinitionLike {
  const registered: ToolDefinitionLike[] = []
  apply(context({
    credentials: KEYED,
    tools: { register: (tool) => { registered.push(tool); return () => {} } },
  }), entry)
  const ask = registered.find(tool => tool.name === 'jev_ask')
  assert.ok(ask !== undefined, 'jev_ask was not registered')
  return ask
}

/** One valid judgment request. */
const ASK = {
  state: 'the ticket',
  questions: { refund: { type: 'noul', instructions: 'Is a refund requested?' } },
}

/** Mount, judge once through `jev_ask`, and report the URLs that were hit. */
async function judgedUrls (entry: unknown): Promise<string[]> {
  const urls: string[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string) => {
    urls.push(url)
    return new Response(
      JSON.stringify({ model: 'jev-1.13.0', answers: { refund: { type: 'noul', noul: 0.22 } } }),
      { status: 200 }
    )
  }) as unknown as typeof fetch
  try {
    const tool = mount(entry)
    const result = await tool.execute(ASK, {
      signal: new AbortController().signal,
      agent: { id: 'agent-1' },
    }) as { ok?: boolean }
    assert.equal(result.ok, true, 'the judgment must succeed for the URL to mean anything')
    return urls
  } finally {
    globalThis.fetch = real
  }
}

test('a configured baseUrl reaches the wire, vendor path included', async () => {
  assert.deepEqual(
    await judgedUrls({ baseUrl: 'https://jev.example.com' }),
    ['https://jev.example.com/v1/systemone']
  )
})

test('with no baseUrl configured the vendor host is used', async () => {
  assert.deepEqual(
    await judgedUrls(undefined),
    ['https://api.typesafe.ai/v1/systemone']
  )
})
