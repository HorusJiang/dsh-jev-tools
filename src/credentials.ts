/**
 * Credential access for the TypeSafe API key.
 *
 * The plugin never stores, caches or logs the key. It resolves the reference
 * on **every operation** — the credentials seam requires that, and it is what
 * lets a user fix a wrong key and have the next judgment pick it up without a
 * restart.
 *
 * @module dsh-jev-tools/credentials
 */

import type { CredentialsService, ResolvedCredential } from './host.js'

/**
 * Environment-variable grammar a `CredentialRef` must satisfy.
 *
 * Mirrors the seam's own guard so a bad `apiKeyEnv` is rejected here with a
 * clear message instead of surfacing as an opaque resolution failure.
 */
const REF_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Why a key could not be used. Drives the user-facing diagnostic. */
export type KeyProblem = 'invalid-name' | 'unconfigured'

/** The outcome of one credential lookup. */
export type KeyLookup =
  | { readonly ok: true, readonly value: string, readonly source: string }
  | { readonly ok: false, readonly problem: KeyProblem, readonly ref: string }

/**
 * Resolve the API key for one operation.
 *
 * @param credentials - the credentials service, or `undefined` when the profile lacks it.
 * @param ref - the environment-variable name to resolve.
 * @returns the resolved key, or the reason it is unusable.
 */
export async function resolveApiKey (
  credentials: CredentialsService | undefined,
  ref: string
): Promise<KeyLookup> {
  if (!REF_NAME.test(ref)) return { ok: false, problem: 'invalid-name', ref }
  if (credentials === undefined) return { ok: false, problem: 'unconfigured', ref }
  let resolved: ResolvedCredential | undefined
  try {
    resolved = await credentials.resolve(ref)
  } catch {
    return { ok: false, problem: 'unconfigured', ref }
  }
  // An empty stored value is absent everywhere by the seam's own rule: a blank
  // must never masquerade as a configured secret.
  if (resolved === undefined || resolved.value === '') {
    return { ok: false, problem: 'unconfigured', ref }
  }
  return { ok: true, value: resolved.value, source: resolved.source }
}
