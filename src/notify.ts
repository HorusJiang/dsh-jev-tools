/**
 * The one notice a session gets when this plugin cannot judge at all.
 *
 * Every capability here is fail-open, which is right for pruning: a judgment
 * that fails must not fail the task. But fail-open has a cost that showed up
 * twice in this project's own history — a wrong `baseUrl`, and a key scoped to
 * another System One host — as **401s that looked exactly like a plugin doing
 * nothing**. There is no error to see, no tool call that turns red, and the only
 * trace is one line in a log nobody reads.
 *
 * So the two reasons that are *structural* get said out loud, once per session,
 * in the session itself:
 *
 *   - `no-key` — nothing can be judged until a human configures one;
 *   - `unauthorized` — 401: a key that no longer works, or one issued for a
 *     different host than the endpoint in force.
 *
 * Transient failures are deliberately excluded: a 429 or a network blip fixes
 * itself, and a notice per blip would be noise on top of noise. A `disabled`
 * switch is excluded too — the user turned it off on purpose.
 *
 * The notice is injected through `agent/pre-step`, which is the only place a
 * host-only plugin can speak to a session (there is no toast, banner or startup
 * channel), and it reaches the model as well as the reader: a model told that
 * pruning is currently inert stops trusting it.
 *
 * @module dsh-jev-tools/notify
 */

import { detectLang, t, type MessageKey } from './i18n.js'
import type { JevSettings } from './config.js'
import type { ContextCache } from './context-cache.js'
import type { PreStepDecision, PreStepListener } from './host.js'
import { noticeSource } from './source.js'

/**
 * The reasons worth interrupting a session for.
 *
 * Narrower than the skip vocabulary on purpose: this module decides what a
 * *reader* has to be told, and a value it does not recognise is simply not a
 * session-notice reason.
 */
export type NoticeReason = 'no-key' | 'unauthorized'

/** Ceiling on per-agent bookkeeping. The host is long-lived; every session is an agent. */
const MAX_AGENTS = 64

/** One agent's notice bookkeeping. */
interface NoticeEntry {
  /** The first reason reported since the last one was said, if any. */
  pending: NoticeReason | undefined
  /** Reasons already said in this session. */
  readonly said: Set<NoticeReason>
}

/** Report failed attempts and collect what still has to be said. */
export interface DegradeNotices {
  /**
   * Report one declined attempt.
   *
   * Called with the same vocabulary every capability already classifies with;
   * a reason that does not deserve a notice is ignored here rather than by the
   * caller, so a call site does not have to know this module's opinion.
   */
  note (agentId: string, reason: string): void
  /**
   * Take the pending reason for an agent, if any, marking it as said.
   *
   * Once per reason per session: the state is structural, so repeating it on
   * every step would be nagging rather than informing.
   */
  take (agentId: string): NoticeReason | undefined
}

/** Whether a skip reason is one a reader has to be told about. */
function noticeReasonOf (reason: string): NoticeReason | undefined {
  return reason === 'no-key' || reason === 'unauthorized' ? reason : undefined
}

/**
 * Create the per-agent notice bookkeeping.
 *
 * @returns the reporter and its reader.
 */
export function createDegradeNotices (): DegradeNotices {
  const agents = new Map<string, NoticeEntry>()

  const entryFor = (agentId: string): NoticeEntry => {
    const existing = agents.get(agentId)
    if (existing !== undefined) return existing
    const entry: NoticeEntry = { pending: undefined, said: new Set() }
    agents.set(agentId, entry)
    // Bounded like every other per-agent map in this plugin: Map iterates in
    // insertion order, so the first key is the least recently created session.
    while (agents.size > MAX_AGENTS) {
      const oldest = agents.keys().next()
      if (oldest.done === true) break
      agents.delete(oldest.value)
    }
    return entry
  }

  return {
    note (agentId, reason) {
      const notice = noticeReasonOf(reason)
      if (notice === undefined) return
      const entry = entryFor(agentId)
      // Already said: nothing to queue. Queueing it again would make the same
      // sentence reappear later in the session for no new information.
      if (entry.said.has(notice)) return
      // First reason wins: if a key is missing *and* the key that is present is
      // refused, the missing key is the one that explains the rest.
      entry.pending ??= notice
    },
    take (agentId) {
      const entry = agents.get(agentId)
      if (entry === undefined || entry.pending === undefined) return undefined
      const notice = entry.pending
      entry.pending = undefined
      entry.said.add(notice)
      return notice
    },
  }
}

/** Everything {@link createDegradeNoticeListener} needs. */
export interface DegradeNoticeDeps {
  readonly notices: DegradeNotices
  readonly settings: () => JevSettings
  readonly cache: ContextCache
  readonly newMessageId: () => string
}

/**
 * Create the `agent/pre-step` listener that says it.
 *
 * @param deps - the bookkeeping and what the notice has to name.
 * @returns the listener.
 */
export function createDegradeNoticeListener (deps: DegradeNoticeDeps): PreStepListener {
  return async (payload, next): Promise<PreStepDecision> => {
    // Delegate first: a later listener owns the final word on the step, and a
    // step that is about to be rejected deserves no notice.
    const downstream = await next()
    if (downstream.kind === 'reject') return downstream

    const settings = deps.settings()
    // A switch the user turned off is not a failure, so it is not announced.
    if (!settings.enabled) return downstream

    const agentId = payload.agent.id
    const reason = deps.notices.take(agentId)
    if (reason === undefined) return downstream

    // Rendered in the conversation's language, like every other output.
    const lang = detectLang(deps.cache.task(agentId))
    const params: Record<string, string> = reason === 'no-key'
      ? { ref: settings.apiKeyEnv }
      : { url: settings.baseUrl }
    const notice = {
      id: deps.newMessageId(),
      role: 'user',
      content: [{ type: 'text', text: t(lang, `notice.${reason}` as MessageKey, params) }],
      source: noticeSource(reason),
    }

    // Append only: the delegated messages are spread back, so this can never
    // become a rewrite of the step.
    return { kind: 'enter', messages: [...downstream.messages, notice] }
  }
}
