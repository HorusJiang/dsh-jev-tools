/**
 * dsh-jev-tools — host entry.
 *
 * Two capabilities that need no change to how you use the harness:
 *   1. semantic pruning of oversized tool results  (tools/post-execute)
 *   2. skill suggestion when the catalog is large   (agent/pre-step, advisory only)
 *
 * Both are inert until a `TYPESAFE_API_KEY` resolves. With no key the plugin
 * still mounts, makes no network request, and every entry point reports why.
 *
 * Stage status: S0–S12 all done. The judgment ledger persists through
 * `storageDomain` when the profile has it (see `src/ledger-domain.ts`) and
 * stays in memory, visibly, when it does not.
 *
 * @module dsh-jev-tools
 */

import { Config, TYPESAFE_KEYS_URL, resolveSettings, type JevSettings } from './config.js'
import { createBudget } from './budget.js'
import { createContextCache, textOfContent } from './context-cache.js'
import { createGatedLedger, createLazyLedger } from './ledger.js'
import { createDomainLedger, ledgerDomainSpec } from './ledger-domain.js'
import { createMemo } from './memo.js'
import { createJevBackend } from './backends/jev.js'
import type { DecisionBackend } from './backends/types.js'
import { createPruneListener } from './features/prune.js'
import { createSkillSuggestListener } from './features/skill-suggest.js'
import { installSettingsNamespace } from './settings-ns.js'
import { registerStatusCommand } from './status.js'
import { createJevAskTool } from './tools/jev-ask.js'
import { createJevGateTool } from './tools/jev-gate.js'
import type {
  CredentialsService, PluginContext, ServiceScope, SkillsService, ToolResultPrunerService,
} from './host.js'

/** Plugin name as the bundle patch mounts it. */
export const name = 'dsh-jev-tools'

/**
 * Hard service dependencies.
 *
 * Empty on purpose: every service is soft-injected, so a profile missing one
 * still mounts the plugin and degrades visibly instead of failing to load.
 */
export const inject: readonly string[] = []

/** Re-export the schema so a composition entry validates against it. */
export { Config }

/** Current resolved settings, refreshed on every committed change. */
let current: JevSettings | undefined

/**
 * Read the settings in force.
 *
 * @returns the resolved settings, or `undefined` before {@link apply} ran.
 */
export function settings (): JevSettings | undefined {
  return current
}

/**
 * Host plugin entry point.
 *
 * @param ctx - the Cordis plugin context.
 * @param entry - the composition entry config, possibly `undefined` when the
 *   bundle row declares no `config:`.
 */
export function apply (ctx: PluginContext, entry?: unknown): void {
  current = resolveSettings(entry)

  // Per-agent state. All of these bound their own growth, because the host is
  // long-lived and every session creates an agent.
  const cache = createContextCache()
  const budget = createBudget(current.prune.perTurnLimit, current.sessionCallLimit)
  const memo = createMemo<readonly unknown[]>(256)

  // The ledger starts in memory and is upgraded to the storage domain as soon
  // as that domain opens. Every caller holds this one stable handle, so the
  // swap — and the replay of whatever was judged during the async open — is
  // invisible above here. With no storage domain the ledger simply stays in
  // memory and `/jev-status` says so.
  //
  // The gate in front of it is `ledger.enabled`: the switch is user-facing, so
  // it has to do something, and a read of the live settings is what keeps it
  // from needing a restart to take effect.
  const lazyLedger = createLazyLedger()
  const ledger = createGatedLedger(
    lazyLedger.ledger,
    () => (current ?? resolveSettings(entry)).ledger.enabled
  )

  // Services are captured, never assumed: any of them may be absent.
  let credentials: CredentialsService | undefined
  let pruner: ToolResultPrunerService | undefined
  let skills: SkillsService | undefined
  ctx.inject(['credentials'], scope => { credentials = scope.credentials })
  ctx.inject(['toolResultPruner'], scope => { pruner = scope.toolResultPruner })
  ctx.inject(['skills'], scope => { skills = scope.skills })

  /**
   * Build a backend for one operation.
   *
   * The endpoint travels with the key, and both are re-read per operation for
   * the same reason: a settings change has to reach the next judgment without a
   * restart. A key issued by a self-hosted or third-party System One host earns
   * a 401 against the default host, and because every capability here is
   * fail-open, that 401 would look like a plugin doing nothing.
   */
  const backendFor = (apiKey: string, model: string): DecisionBackend =>
    createJevBackend({ apiKey, model, baseUrl: (current ?? resolveSettings(entry)).baseUrl })

  ctx.inject(['storageDomain'], (scope: ServiceScope) => {
    const facility = scope.storageDomain
    if (facility === undefined) return
    void (async () => {
      try {
        const domain = await facility.open(ledgerDomainSpec())
        // The caller owns the handle; closing it is this plugin's job.
        ctx.effect(() => () => { void domain.close() })
        lazyLedger.attach(createDomainLedger({
          domain,
          log: message => { ctx.logger?.warn(`[dsh-jev-tools] ${message}`) },
        }))
        ctx.logger?.info(`[dsh-jev-tools] judgment ledger persisted (domain ${domain.name})`)
      } catch (error) {
        // Bookkeeping is never worth a failed mount: judging continues, and
        // the status report shows that the counters are memory-only.
        ctx.logger?.warn(
          '[dsh-jev-tools] ledger persistence unavailable; counters stay in memory:', error
        )
      }
    })()
  })

  installSettingsNamespace(ctx, entry ?? {}, () => {
    // Re-resolve on change rather than trusting a cached copy: enabling or
    // disabling a capability must take effect without a restart.
    current = resolveSettings(entry)
    ctx.logger?.info(`[dsh-jev-tools] settings changed; enabled=${String(current.enabled)}`)
  })

  // The current request and turn. Needed because neither `tools/post-execute`
  // nor `AssembleContext` exposes the conversation, and `ToolExecution` carries
  // no turn number for the per-turn quota to read.
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    cache.remember(agent.id, textOfContent(message.content))
    cache.rememberTurn(agent.id, turn)
  })

  ctx.on('tools/post-execute', createPruneListener({
    settings: () => current ?? resolveSettings(entry),
    credentials: () => credentials,
    backendFor,
    pruner: () => pruner,
    cache,
    budget,
    memo,
    ledger,
    now: () => Date.now(),
    newMessageId: () => `jev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  }))

  // Advisory only: this listener appends a notice to the step's messages and
  // never rejects, so a wrong suggestion costs a line of prompt, not a step.
  ctx.on('agent/pre-step', createSkillSuggestListener({
    settings: () => current ?? resolveSettings(entry),
    credentials: () => credentials,
    backendFor,
    skills: () => skills,
    cache,
    budget,
    ledger,
    now: () => Date.now(),
    newMessageId: () => `jev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    log: message => { ctx.logger?.warn(`[dsh-jev-tools] ${message}`) },
  }))

  // The model-facing tools. Their registration is also the plugin's one
  // inspectable surface: `Tool.listTools` shows them, which is how a host-side
  // change is proven to have actually loaded.
  ctx.inject(['tools'], (scope: ServiceScope) => {
    const tools = scope.tools
    if (tools === undefined) return
    const shared = {
      settings: () => current ?? resolveSettings(entry),
      credentials: () => credentials,
      backendFor,
      cache,
      budget,
      ledger,
      now: () => Date.now(),
    }
    for (const [label, create] of [
      ['jev_ask', createJevAskTool],
      ['jev_gate', createJevGateTool],
    ] as const) {
      try {
        tools.register(create(shared))
      } catch (error) {
        // One tool failing to register must not take the other down with it.
        ctx.logger?.warn(`[dsh-jev-tools] ${label} unavailable:`, error)
      }
    }
  })

  registerStatusCommand(ctx, {
    settings: () => current ?? resolveSettings(entry),
    credentials: () => credentials,
    cache,
    budget,
    ledger,
  })

  ctx.logger?.info(
    `[dsh-jev-tools] mounted (key ref=${current.apiKeyEnv}, model=${current.model}). `
    + `Configure a key at ${TYPESAFE_KEYS_URL}`
  )
}
