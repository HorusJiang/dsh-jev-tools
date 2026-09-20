/**
 * Credential policy tests.
 *
 * The load-bearing rule is that an unusable key is reported as a *reason*, not
 * thrown and not silently treated as present — every caller needs to degrade
 * visibly.
 *
 * @module dsh-jev-tools/test/credentials
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveApiKey } from '../lib/credentials.js'
import type { CredentialsService } from '../lib/host.js'

/** A credentials service resolving to a fixed answer. */
function stub (answer: { value: string, source: string } | undefined): CredentialsService {
  return { resolve: async () => answer, describe: async () => ({ configured: answer !== undefined, writable: true }) }
}

test('a malformed reference name is rejected before touching the service', async () => {
  let called = false
  const service: CredentialsService = {
    resolve: async () => { called = true; return { value: 'x', source: 'env' } },
    describe: async () => ({ configured: false, writable: true }),
  }
  const result = await resolveApiKey(service, 'not a name!')
  assert.deepEqual(result, { ok: false, problem: 'invalid-name', ref: 'not a name!' })
  assert.equal(called, false)
})

test('a missing credentials service reports unconfigured rather than throwing', async () => {
  const result = await resolveApiKey(undefined, 'TYPESAFE_API_KEY')
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.problem, 'unconfigured')
})

test('an empty stored value is absent, never a configured secret', async () => {
  // The credentials seam's own rule: a blank must never masquerade as present.
  const result = await resolveApiKey(stub({ value: '', source: 'file' }), 'TYPESAFE_API_KEY')
  assert.equal(result.ok, false)
})

test('an undefined resolution reports unconfigured', async () => {
  const result = await resolveApiKey(stub(undefined), 'TYPESAFE_API_KEY')
  assert.equal(result.ok, false)
})

test('a service that throws degrades instead of propagating', async () => {
  const service: CredentialsService = {
    resolve: async () => { throw new Error('backend down') },
    describe: async () => ({ configured: false, writable: true }),
  }
  const result = await resolveApiKey(service, 'TYPESAFE_API_KEY')
  assert.equal(result.ok, false)
})

test('a resolved key carries its source for diagnostics', async () => {
  const result = await resolveApiKey(stub({ value: 'sk-live', source: 'env' }), 'TYPESAFE_API_KEY')
  assert.deepEqual(result, { ok: true, value: 'sk-live', source: 'env' })
})

test('resolution is per call and never cached across operations', async () => {
  // The seam requires this: it is what lets a corrected key reach the next
  // operation without a restart. A cache here would silently break that.
  let calls = 0
  const service: CredentialsService = {
    resolve: async () => { calls += 1; return { value: `sk-${calls}`, source: 'env' } },
    describe: async () => ({ configured: true, writable: true }),
  }
  const first = await resolveApiKey(service, 'TYPESAFE_API_KEY')
  const second = await resolveApiKey(service, 'TYPESAFE_API_KEY')
  assert.equal(calls, 2)
  assert.equal(first.ok === true && first.value, 'sk-1')
  assert.equal(second.ok === true && second.value, 'sk-2')
})
