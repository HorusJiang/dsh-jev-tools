/**
 * One vocabulary for "why nothing happened".
 *
 * Every capability can decline for a dozen reasons, and the difference matters
 * to whoever is looking at a session where the plugin appears to do nothing.
 * A missing key, an exhausted quota and a deliberately skipped small result all
 * look identical from the outside unless the reason is carried as a value.
 *
 * @module dsh-jev-tools/degrade
 */

import { MESSAGE_KEYS, t, type Lang, type MessageKey } from './i18n.js'

/** Why a capability did not act. */
export type SkipReason =
  | 'disabled' // the master switch or this capability's own switch is off
  | 'no-key' // no TYPESAFE_API_KEY resolved
  | 'budget-turn' // this turn's quota is spent
  | 'budget-session' // this session's quota is spent
  | 'too-small' // below the size floor: not worth a judgment
  | 'tool-not-allowed' // the tool is outside the allowlist
  | 'is-error' // the result was an error; never rewrite those
  | 'cached' // already judged this exact input
  | 'no-task' // the current request is unknown, so relevance cannot be judged
  | 'task-too-vague' // the request is known but carries no usable signal
  | 'no-saving' // pruning would not have saved enough to be worth the distortion
  | 'no-skills' // the skill registry is not visible to this plugin
  | 'catalog-unavailable' // reading the skill catalog failed
  | 'catalog-too-small' // the catalog is below the size floor for a suggestion
  | 'shadow' // judged, but shadow mode left the payload untouched on purpose
  | 'empty' // nothing judgeable in the payload
  | 'aborted' // the caller cancelled
  | 'invalid-request' // refused by the pre-flight guards
  | 'unauthorized' // 401 — bad or missing key
  | 'bad-request' // 422 — the body was rejected
  | 'rate-limited' // 429
  | 'overloaded' // 529
  | 'server' // 5xx or an unreadable success body
  | 'network' // transport failure
  | 'malformed-response' // a 200 this client cannot read
  | 'unknown' // a thrown error with no classification

/**
 * Human-readable phrasing for a skip reason.
 *
 * The text lives in the shared catalog (`i18n.ts`) rather than here, because
 * these phrases are read by a *user* in `/jev-status`, not just by the plugin:
 * they must follow the conversation's language like every other message.
 *
 * @param reason - the classification.
 * @param lang - the language to render in.
 * @returns a short phrase suitable for a session notice.
 */
export function skipMessage (reason: SkipReason, lang: Lang): string {
  return t(lang, `skip.${reason}` as MessageKey)
}

/**
 * Map a thrown judgment failure onto a skip reason.
 *
 * Keeps the caller from having to know the backend's error taxonomy: anything
 * it cannot place becomes `unknown` rather than escaping.
 *
 * @param problem - the failure's own classification, if it had one.
 * @returns the skip reason to report.
 */
export function reasonFromFailure (problem: string | undefined): SkipReason {
  if (problem === undefined) return 'unknown'
  const candidate = `skip.${problem}` as MessageKey
  return MESSAGE_KEYS.includes(candidate) ? (problem as SkipReason) : 'unknown'
}