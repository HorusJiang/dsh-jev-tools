/**
 * Per-agent memory of the current request.
 *
 * Relevance is undecidable without knowing what the session is trying to do,
 * and neither `tools/post-execute` (which carries only the call's name,
 * arguments and agent) nor `AssembleContext` (scope and signal) exposes the
 * conversation. So the request is captured from the two places that do carry
 * it, whichever arrives first, and looked up by agent id.
 *
 * This is a cache of *recent user text*, not a transcript: it keeps one string
 * per agent, bounded in length, and drops an agent's entry when it goes away.
 *
 * @module dsh-jev-tools/context-cache
 */

/** Longest request text retained per agent, in characters. */
const MAX_LENGTH = 4_000

/** How many recent user messages make up the current task description. */
const MAX_MESSAGES = 3

/** Owners of the current request, keyed by agent id. */
export interface ContextCache {
  /** Record the request text for one agent. Empty text is ignored. */
  remember (agentId: string, text: string): void
  /** Read the request text for one agent, or `undefined` when unknown. */
  task (agentId: string): string | undefined
  /**
   * Record the turn an agent is on.
   *
   * `ToolExecution` carries no turn number, but `agent/pre-step` and
   * `agent/inbox/claimed` both do, so the per-turn quota reads it from here.
   */
  rememberTurn (agentId: string, turn: number): void
  /** The current turn for one agent, or `undefined` when unknown. */
  turn (agentId: string): number | undefined
  /** Forget one agent. */
  forget (agentId: string): void
  /** Number of agents currently remembered (diagnostics and bounds). */
  readonly size: number
}

/**
 * Create a bounded per-agent request cache.
 *
 * @param maxAgents - ceiling on remembered agents; the oldest insertion is
 *   evicted. A long-lived host sees many short-lived agents, so an unbounded
 *   map here would be a slow leak.
 * @returns the cache.
 */
export function createContextCache (maxAgents = 64): ContextCache {
  // A *list* per agent, not a single string: one terse message ("继续吧",
  // "ok", "go on") carries no usable signal, so relevance judged against it is
  // noise. Keeping the last few messages gives the task enough context to be
  // worth judging against.
  const byAgent = new Map<string, string[]>()
  const turns = new Map<string, number>()

  return {
    remember (agentId, text) {
      const trimmed = text.trim()
      if (trimmed === '') return
      const history = byAgent.get(agentId) ?? []
      // Ignore a repeat of the immediately preceding message.
      if (history[history.length - 1] === trimmed) return
      history.push(trimmed)
      while (history.length > MAX_MESSAGES) history.shift()
      // Re-insert so the eviction order is least-recently-used.
      byAgent.delete(agentId)
      byAgent.set(agentId, history)
      while (byAgent.size > maxAgents) {
        const oldest = byAgent.keys().next()
        if (oldest.done === true) break
        byAgent.delete(oldest.value)
      }
    },
    task (agentId) {
      const history = byAgent.get(agentId)
      if (history === undefined || history.length === 0) return undefined
      // Oldest first, so the request that framed the work precedes the
      // follow-ups that refine it. Truncated from the front when long.
      const joined = history.join('\n')
      return joined.length > MAX_LENGTH ? joined.slice(joined.length - MAX_LENGTH) : joined
    },
    rememberTurn (agentId, turn) {
      if (!Number.isFinite(turn)) return
      turns.set(agentId, turn)
      while (turns.size > maxAgents) {
        const oldest = turns.keys().next()
        if (oldest.done === true) break
        turns.delete(oldest.value)
      }
    },
    turn (agentId) {
      return turns.get(agentId)
    },
    forget (agentId) {
      byAgent.delete(agentId)
      turns.delete(agentId)
    },
    get size () {
      return byAgent.size
    },
  }
}

/**
 * Extract the plain text of a message-like value.
 *
 * @param content - a `ContentBlock[]`-shaped value.
 * @returns the concatenated text blocks.
 */
export function textOfContent (content: unknown): string {
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block !== null && typeof block === 'object') {
      const typed = block as { type?: unknown, text?: unknown }
      if (typed.type === 'text' && typeof typed.text === 'string') text += `${typed.text}\n`
    }
  }
  return text
}
