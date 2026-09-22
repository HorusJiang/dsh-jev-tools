/**
 * Runtime status and diagnosis.
 *
 * This exists because "the plugin appears to do nothing" has a dozen causes
 * that look identical from outside — a missing key, an exhausted quota, an
 * unknown current request, a payload under the size floor — and every one of
 * them is invisible unless it is reported. It is also the honest answer to
 * "is this costing me anything, and is it doing what I think?".
 *
 * @module dsh-jev-tools/status
 */

import { resolveApiKey } from './credentials.js'
import { detectLang, t, type Lang } from './i18n.js'
import { TYPESAFE_KEYS_URL, type JevSettings } from './config.js'
import type { ContextCache } from './context-cache.js'
import type { Budget } from './budget.js'
import type { Ledger } from './ledger.js'
import type { CredentialsService, CommandsService, PluginContext, ServiceScope } from './host.js'

/** Everything the report reads. */
export interface StatusDeps {
  readonly settings: () => JevSettings
  readonly credentials: () => CredentialsService | undefined
  readonly cache: ContextCache
  readonly budget: Budget
  readonly ledger: Ledger
}

/** Yes/no in the report's own voice. */
const onOff = (value: boolean, lang: Lang): string =>
  (lang === 'zh' ? (value ? '开' : '关') : (value ? 'on' : 'off'))

/**
 * Render the report.
 *
 * @param deps - what to read.
 * @param agentId - the agent whose per-session counters to report, when known.
 * @returns a plain-text report, safe to show a user verbatim.
 */
export async function buildStatus (deps: StatusDeps, agentId?: string): Promise<string> {
  const settings = deps.settings()
  // The conversation's language, so the diagnosis matches what the user is
  // reading. Falls back to English when nothing has been said yet.
  const lang = detectLang(agentId === undefined ? undefined : deps.cache.task(agentId))
  const lines: string[] = []

  lines.push(t(lang, 'status.title'))
  lines.push('')
  lines.push(`${t(lang, 'status.master')}: ${onOff(settings.enabled, lang)}`)

  const prune = settings.prune
  lines.push(t(lang, 'status.prune', {
    state: onOff(prune.enabled, lang),
    minTokens: prune.minTokens,
    perTurn: prune.perTurnLimit,
    allowlist: prune.toolAllowlist.join('/'),
  }))
  lines.push(t(lang, 'status.suggest', {
    state: onOff(settings.suggest.enabled, lang),
    minCatalog: settings.suggest.minCatalogSize,
  }))
  const screen = settings.screen
  lines.push(t(lang, 'status.screen', {
    state: onOff(screen.enabled, lang),
    threshold: screen.threshold,
    minTokens: screen.minTokens,
    allowlist: screen.toolAllowlist.join('/'),
  }))
  if (settings.prune.shadow) lines.push(t(lang, 'status.shadow'))
  lines.push(t(lang, 'status.model', { model: settings.model }))
  // Where the content actually goes. With the endpoint configurable this stops
  // being a constant, and a wrong one is indistinguishable from a plugin that
  // does nothing: the key resolves, every request 401s, and fail-open hides it.
  lines.push(t(lang, 'status.endpoint', { url: settings.baseUrl }))
  lines.push('')

  // Credentials: re-resolved here exactly as every operation does, so this
  // reports what the next judgment will actually see.
  const key = await resolveApiKey(deps.credentials(), settings.apiKeyEnv)
  if (key.ok) {
    lines.push(t(lang, 'status.key.ok', { ref: settings.apiKeyEnv, source: key.source }))
  } else if (key.problem === 'invalid-name') {
    lines.push(t(lang, 'status.key.badName', { ref: settings.apiKeyEnv }))
  } else {
    lines.push(t(lang, 'status.key.missing', { ref: settings.apiKeyEnv }))
    lines.push(t(lang, 'status.key.where', { url: TYPESAFE_KEYS_URL }))
  }
  if (deps.credentials() === undefined) lines.push(t(lang, 'status.key.noService'))
  lines.push('')

  // Why-judgments-did-not-happen is the part that matters most: without it,
  // "nothing happened" and "everything is broken" look the same.
  const entries = deps.ledger.entries()
  const summary = deps.ledger.summary()
  const skipped = entries.filter(entry => entry.outcome === 'skipped')
  const reasons = new Map<string, number>()
  for (const entry of skipped) {
    if (entry.skip === undefined) continue
    reasons.set(entry.skip, (reasons.get(entry.skip) ?? 0) + 1)
  }

  // Cumulative, not per-run: with the durable ledger these numbers outlive a
  // restart, and a saving that resets every session is not a measurement.
  lines.push(t(lang, 'status.ledger', {
    total: summary.records, judged: summary.judged, skipped: summary.skipped,
  }))
  if (summary.retained < summary.records) {
    lines.push(t(lang, 'status.ledger.retained', { retained: summary.retained }))
  }
  // Where the records live is a question the user cannot answer from outside,
  // and it decides whether the numbers above survive the next restart.
  const store = deps.ledger.store
  lines.push(t(lang, store.kind === 'domain' ? 'status.store.domain' : 'status.store.memory'))
  if (store.failures > 0) {
    lines.push(t(lang, 'status.store.failures', { count: store.failures }))
  }
  // A switch the user can flip must be visible in the report, or "why is the
  // ledger empty" becomes unanswerable.
  if (!settings.ledger.enabled) lines.push(t(lang, 'status.ledger.off'))

  if (agentId !== undefined) {
    lines.push(t(lang, 'status.session', {
      used: deps.budget.sessionUsage(agentId), limit: settings.sessionCallLimit,
    }))
    const task = deps.cache.task(agentId)
    lines.push(task === undefined
      ? t(lang, 'status.task.unknown')
      : t(lang, 'status.task.known', { preview: task.slice(0, 40).replace(/\s+/g, ' ') }))
    const turn = deps.cache.turn(agentId)
    lines.push(t(lang, 'status.turn', { turn: turn === undefined ? '—' : String(turn) }))
    lines.push(t(lang, 'status.taskHint'))
  }

  if (reasons.size > 0) {
    lines.push('')
    lines.push(t(lang, 'status.skipHeading'))
    for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${reason} × ${count}`)
    }
    lines.push(t(lang, 'status.recentHeading'))
    for (const entry of skipped.slice(-5)) {
      lines.push(t(lang, 'status.recentLine', {
        reason: entry.skip ?? '—',
        feature: entry.feature,
        tokens: Math.round(entry.originalTokens ?? 0),
      }))
    }
  }

  if (summary.judged > 0) {
    lines.push('')
    lines.push(t(lang, 'status.saved', { tokens: Math.round(summary.savedTokens) }))
    if (summary.baselineSavedTokens > 0 || summary.netTokens !== 0) {
      lines.push(t(lang, 'status.baseline', { tokens: Math.round(summary.baselineSavedTokens) }))
      lines.push(t(lang, 'status.net', { tokens: Math.round(summary.netTokens) }))
    }
    const models = Object.entries(summary.models)
    if (models.length > 0) {
      lines.push(t(lang, 'status.versions', {
        list: models.map(([m, n]) => `${m} × ${n}`).join(', '),
      }))
    }
  }

  return lines.join('\n')
}

/**
 * Register `/jev-status`.
 *
 * @param ctx - the plugin context.
 * @param deps - what the report reads.
 */
export function registerStatusCommand (ctx: PluginContext, deps: StatusDeps): void {
  ctx.inject(['commands'], (scope: ServiceScope) => {
    const commands = scope.commands as CommandsService | undefined
    if (commands === undefined) return
    try {
      commands.register({
        name: 'jev-status',
        description: '报告 Jev 插件的启用状态、API key、判定次数与跳过原因 / '
          + 'Show the Jev plugin status: enabled capabilities, API key, judgment counts, and skip reasons',
        async handler (invocation) {
          try {
            const text = await buildStatus(deps, invocation.agent.id)
            return { kind: 'success', text }
          } catch (error) {
            return { kind: 'error', text: `无法读取状态 / could not read status: ${String(error)}` }
          }
        },
      })
    } catch (error) {
      ctx.logger?.warn('[dsh-jev-tools] /jev-status unavailable:', error)
    }
  })
}
