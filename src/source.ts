/**
 * The one producer identity every message this plugin appends carries.
 *
 * Session format v4 has no shared catch-all source kind: each message states
 * *who produced it*, and the retired `{ kind: 'plugin', plugin }` wrapper is
 * refused outright — the writer fails the whole turn with
 * `format v4 message requires a producer-owned source kind`. So the plugin
 * names itself in `kind` instead of in a property beside a literal `'plugin'`.
 *
 * `plugin:dsh-jev-tools` is the value the harness's own v3->v4 migration records
 * for this plugin's historical notices, so a session upgraded across that edge
 * and a session written today agree on one identity rather than splitting into
 * two.
 *
 * @module dsh-jev-tools/source
 */

/** Plugin identity used in the injected notice's source. */
export const PLUGIN_ID = 'dsh-jev-tools'

/**
 * Producer-owned source kind for every durable message this plugin appends.
 *
 * A literal `'plugin'` kind is reserved by the session format as the retired
 * wrapper and is rejected on write; the producer's own name is the kind.
 */
export const PLUGIN_SOURCE_KIND = `plugin:${PLUGIN_ID}`

/**
 * The source of one advisory this plugin injects.
 *
 * `kind` answers who produced it. `form: 'notice'` answers what kind of thing it
 * is — a one-off account of something that just happened, which supersedes
 * nothing — and `summary` is the single line a reader shows without expanding
 * the row.
 */
export interface NoticeSource {
  readonly kind: string
  readonly form: 'notice'
  readonly summary: string
}

/**
 * Build the source of one injected notice.
 *
 * @param summary - one-line account of what the judgment did.
 * @returns the `notice`-form source for this plugin's message.
 */
export function noticeSource (summary: string): NoticeSource {
  return { kind: PLUGIN_SOURCE_KIND, form: 'notice', summary }
}
