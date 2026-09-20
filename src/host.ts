/**
 * Structural shapes for the host services this plugin consumes.
 *
 * These are deliberately NOT imported from `@deepseek-ai/dsh-*`. The
 * npm-published packages lag the deployment badly — `@deepseek-ai/dsh-settings`
 * is `0.0.1-rc.1` on the registry while the running harness is
 * `0.1.6-alpha.2` — so a plugin that type-depends on them compiles against
 * signatures the host does not have. The real contract is the **service key
 * string** plus the shapes below, and structural typing keeps this plugin
 * working across harness releases instead of breaking on a type rename.
 *
 * @module dsh-jev-tools/host
 */

/** A resolved credential value and where it came from. */
export interface ResolvedCredential {
  readonly value: string
  readonly source: string
}

/** Configuration-surface description of a credential reference. Never carries the literal. */
export interface CredentialInfo {
  readonly configured: boolean
  readonly source?: string
  readonly writable: boolean
}

/**
 * `ctx.credentials` — the reference half.
 *
 * One rule binds every consumer: **resolution is per call**. A consumer must
 * re-resolve at each operation and must not cache across operations; that
 * per-operation read is what makes a changed credential reach the next
 * operation without a restart.
 */
export interface CredentialsService {
  resolve (ref: string): Promise<ResolvedCredential | undefined>
  describe (ref: string): Promise<CredentialInfo>
}

/** Hooks one optional-settings consumer supplies to the settings provider. */
export interface SettingsSectionHooks<T> {
  setSource (current: () => T): void
  onChange (): void
  validate? (value: T): void
}

/** `ctx.settings` — namespace registration and configuration surfaces. */
export interface SettingsService {
  installSection (
    owner: unknown,
    ns: string,
    schema: unknown,
    entry: unknown,
    hooks: SettingsSectionHooks<never>
  ): void
  get (ns: string): unknown
}

/** Logging surface. Optional: a context without it must not crash the plugin. */
export interface Logger {
  info (...args: unknown[]): void
  warn (...args: unknown[]): void
  error (...args: unknown[]): void
}

/**
 * `ctx.toolResultPruner` — DSH's own deterministic pruner.
 *
 * Read-only here, and only for measurement: calling `pruneContent` on a
 * payload says what the *existing* baseline would have cut, which is how the
 * ledger separates this plugin's increment from the machine it replaced.
 */
export interface ToolResultPrunerService {
  measureContent (blocks: readonly unknown[]): number
  pruneContent (blocks: readonly unknown[]): readonly unknown[] | null
}

/** One human-facing slash command. */
export interface CommandDefinition {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string, readonly attachments?: boolean }
  readonly recordInput?: boolean
  readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}

/** What a command handler receives. */
export interface CommandInvocation {
  readonly commandId: string
  readonly agent: { readonly id: string }
  readonly rawInput: string
  readonly attachments: readonly unknown[]
  readonly signal: AbortSignal
}

/** What a command handler returns. */
export type CommandResult =
  | { readonly kind: 'success', readonly text?: string }
  | { readonly kind: 'error', readonly text: string }

/** `ctx.commands` — the human-command registry. */
export interface CommandsService {
  register (definition: CommandDefinition): () => void
}

/** The presentation half of a tool definition. */
export interface ToolOutputDefinitionLike {
  readonly schema: unknown
  render (args: unknown, value: unknown): readonly unknown[]
}

/** One model-facing tool. */
export interface ToolDefinitionLike {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: ToolOutputDefinitionLike
  execute (args: unknown, exec: { readonly signal: AbortSignal, readonly agent?: AgentLike }): Promise<unknown>
  timeoutMs?: number
  isConcurrencySafe? (args: unknown): boolean
}

/** `ctx.tools` — the tool registry. */
export interface ToolsService {
  register (definition: ToolDefinitionLike): () => void
}

/** One entry of the skill catalog. */
export interface SkillSummaryLike {
  readonly name: string
  readonly description: string
}

/** `ctx.skills` — the layered skill registry. */
export interface SkillsService {
  list (options?: unknown): Promise<readonly SkillSummaryLike[]>
}

/**
 * One table of an open domain.
 *
 * Reads are synchronous, from the domain's authoritative in-memory state; only
 * writes are durable and asynchronous. Returned values are the stored objects
 * themselves, so a value read here must never be mutated in place.
 */
export interface DomainTableLike<V> {
  get (key: string): V | undefined
  entries (): IterableIterator<[string, V]>
  keys (): IterableIterator<string>
  readonly size: number
  put (key: string, value: V): Promise<void>
  delete (key: string): Promise<boolean>
  update (key: string, fn: (current: V) => V): Promise<V>
}

/** One open domain. The caller owns it and closes it. */
export interface DomainLike {
  readonly name: string
  table (name: string): DomainTableLike<unknown>
  close (): Promise<void>
}

/**
 * `ctx.storageDomain` — schema-validated, change-emitting KV domains.
 *
 * `open` is typed as taking a spec literal rather than a `defineDomain` result
 * because `defineDomain` is only a validator, and this plugin does not import
 * the published `@deepseek-ai/dsh-storage-domain` types (see the module header).
 */
export interface DomainFacilityLike {
  open (spec: unknown): Promise<DomainLike>
  get (name: string): DomainLike | undefined
}

/** The step an `agent/pre-step` listener is about to let through. */
export interface PreStepPayload {
  readonly agent: AgentLike
  readonly messages: readonly unknown[]
  readonly turn: number
  readonly signal: AbortSignal
}

/**
 * What an `agent/pre-step` listener returns.
 *
 * `reject` cancels the step. `enter` *replaces* the messages that enter it —
 * which is why a listener that only wants to add something must spread the
 * original array rather than build a new one.
 */
export type PreStepDecision =
  | { readonly kind: 'reject' }
  | { readonly kind: 'enter', readonly messages: readonly unknown[], readonly startsRequestSeries?: true }

/** An `agent/pre-step` listener. */
export type PreStepListener = (
  payload: PreStepPayload,
  next: () => Promise<PreStepDecision>
) => Promise<PreStepDecision>

/**
 * The scope a service-injected callback receives.
 *
 * Services are optional by construction — a profile may lack any of them — so
 * every consumer checks presence rather than assuming it.
 */
export interface ServiceScope {
  settings?: SettingsService
  credentials?: CredentialsService
  toolResultPruner?: ToolResultPrunerService
  commands?: CommandsService
  tools?: ToolsService
  skills?: SkillsService
  storageDomain?: DomainFacilityLike
  [service: string]: unknown
}

/** An agent reference: only its identity is ever exposed. */
export interface AgentLike {
  readonly id: string
}

/** The tool call a post-execute listener sees. */
export interface ToolExecutionLike {
  readonly name: string
  readonly arguments: unknown
  readonly callId: string
  readonly agent?: AgentLike | undefined
  readonly signal: AbortSignal
}

/** A normalized dispatch outcome. */
export interface ToolExecutionResultLike {
  readonly isError: boolean
  readonly content: readonly unknown[]
}

/**
 * What a `tools/post-execute` listener returns.
 *
 * `content` replaces the accepted payload; `additionalContexts` rides either
 * accept variant *and* the block variant, so a notice can be attached without
 * changing whether the call was allowed.
 */
export type PostToolDecision =
  | { readonly kind: 'accept', readonly content?: readonly unknown[], readonly additionalContexts?: readonly unknown[] }
  | { readonly kind: 'accept', readonly value: unknown, readonly additionalContexts?: readonly unknown[] }
  | { readonly kind: 'block', readonly feedback: readonly unknown[], readonly additionalContexts?: readonly unknown[] }

/** The waterfall continuation. */
export type NextDecision = () => Promise<PostToolDecision>

/** A `tools/post-execute` listener. */
export type PostToolListener = (
  exec: ToolExecutionLike,
  result: ToolExecutionResultLike,
  next: NextDecision
) => Promise<PostToolDecision>

/** One message leaving the inbox inside an open turn. */
export interface InboxClaimedPayload {
  readonly agent: AgentLike
  readonly message: { readonly content?: unknown }
  readonly turn: number
}

/** The Cordis plugin context, reduced to what this plugin actually uses. */
export interface PluginContext {
  readonly logger?: Logger
  /** Run `callback` in a child scope once every named service is available. */
  inject (names: readonly string[], callback: (scope: ServiceScope) => void): void
  /** Register a resource whose returned disposer runs when the plugin unloads. */
  effect (callback: () => void | (() => void)): void
  /** Observe each tool result, and optionally replace or block it. */
  on (event: 'tools/post-execute', listener: PostToolListener): () => void
  /** Observe each user message entering a turn. */
  on (event: 'agent/inbox/claimed', listener: (payload: InboxClaimedPayload) => void): () => void
  /** Observe each step about to run, and optionally replace its messages. */
  on (event: 'agent/pre-step', listener: PreStepListener): () => void
  /** Anything else this plugin has no reason to subscribe to. */
  on (event: string, listener: (...args: never[]) => unknown): () => void
}
