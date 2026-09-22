/**
 * Judgment quotas.
 *
 * S0 measured what happens without one: a single turn can present 27
 * oversized read-family results, which at roughly 300 ms each is 8.1 seconds
 * of added serial latency. The per-turn ceiling is therefore not an
 * optimisation but the mechanism that bounds the cost — measured, it is what
 * holds the worst turn to 0.9 s.
 *
 * The session ceiling exists for a different reason: it is the hard stop on
 * how much content leaves the machine and how much the user's key is spent,
 * across every capability that judges.
 *
 * @module dsh-jev-tools/budget
 */

/** Why a judgment was refused. */
export type BudgetRefusal = 'budget-turn' | 'budget-session'

/** The result of asking for one judgment. */
export type BudgetGrant =
  | { readonly ok: true }
  | { readonly ok: false, readonly reason: BudgetRefusal }

/** A per-turn and per-session allowance. */
export interface Budget {
  /**
   * Consume one allowance for an automatic capability, bounded per turn as well
   * as per session.
   */
  tryConsume (agentId: string, turn: number): BudgetGrant
  /**
   * Consume one allowance for an explicit call, bounded per session only.
   *
   * The per-turn ceiling exists to bound the latency an *automatic* capability
   * can add to a turn — measured, 27 uncapped triggers ≈ 8.1 s against 0.9 s at
   * a cap of three. An explicit `jev_ask` / `jev_gate` is the caller asking for
   * one answer, so that ceiling has no rationale there. Worse, such a call
   * carries no turn number, and passing a placeholder turned the per-turn
   * ceiling into a session-long cap of three: the fourth call onwards was
   * refused with `budget-turn` for the rest of the session.
   */
  tryConsumeSession (agentId: string): BudgetGrant
  /** Judgments consumed in this session so far. */
  sessionUsage (agentId: string): number
  /** Judgments consumed in one turn so far. */
  turnUsage (agentId: string, turn: number): number
  /** Forget an agent's counters. */
  forget (agentId: string): void
}

/**
 * Create a quota tracker.
 *
 * @param perTurn - maximum judgments in one turn.
 * @param perSession - maximum judgments in one session.
 * @param maxAgents - ceiling on tracked agents, so a long-lived host does not leak.
 * @returns the budget.
 */
export function createBudget (perTurn: number, perSession: number, maxAgents = 64): Budget {
  interface Counters { session: number, turns: Map<number, number> }
  const byAgent = new Map<string, Counters>()

  const countersFor = (agentId: string): Counters => {
    const existing = byAgent.get(agentId)
    if (existing !== undefined) return existing
    const fresh: Counters = { session: 0, turns: new Map() }
    byAgent.set(agentId, fresh)
    while (byAgent.size > maxAgents) {
      const oldest = byAgent.keys().next()
      if (oldest.done === true) break
      byAgent.delete(oldest.value)
    }
    return fresh
  }

  return {
    tryConsume (agentId, turn) {
      const counters = countersFor(agentId)
      if (counters.session >= perSession) return { ok: false, reason: 'budget-session' }
      const used = counters.turns.get(turn) ?? 0
      if (used >= perTurn) return { ok: false, reason: 'budget-turn' }
      counters.session += 1
      counters.turns.set(turn, used + 1)
      return { ok: true }
    },
    tryConsumeSession (agentId) {
      const counters = countersFor(agentId)
      if (counters.session >= perSession) return { ok: false, reason: 'budget-session' }
      counters.session += 1
      return { ok: true }
    },
    sessionUsage (agentId) {
      return byAgent.get(agentId)?.session ?? 0
    },
    turnUsage (agentId, turn) {
      return byAgent.get(agentId)?.turns.get(turn) ?? 0
    },
    forget (agentId) {
      byAgent.delete(agentId)
    },
  }
}
