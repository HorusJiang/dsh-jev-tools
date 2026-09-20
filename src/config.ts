/**
 * Plugin settings schema.
 *
 * Every default here is a *measured* decision, not a guess — see
 * `docs/s0-trigger-rate.md` for the numbers behind `minTokens`, `perTurnLimit`
 * and `minCatalogSize`.
 *
 * @module dsh-jev-tools/config
 */

import Schema from '@deepseek-ai/schemastery'

/** Settings namespace this plugin owns. Must be a lowercase-hyphenated identifier. */
export const JEV_TOOLS_NS = 'dsh-jev-tools'

/** Where a user creates a TypeSafe API key. Shown as a link in the settings card. */
export const TYPESAFE_KEYS_URL = 'https://console.typesafe.ai/keys'

/**
 * Default credential reference.
 *
 * Deliberately the same environment variable the official TypeSafe SDK reads,
 * so anyone already using Jev with the official tooling works with no setup.
 */
export const DEFAULT_API_KEY_ENV = 'TYPESAFE_API_KEY'

/**
 * Tools whose bulk output is worth judging for relevance.
 *
 * Measured: at `minTokens` 2000 these covered 76% of oversized results.
 * `pwsh` is deliberately absent — terminal output carries build logs, error
 * traces and file listings whose "irrelevant" parts are often exactly what a
 * debugging step needs, so a cheap judgment must not trim them.
 */
export const DEFAULT_TOOL_ALLOWLIST = ['read', 'grep', 'glob', 'web_fetch', 'web_search']

/**
 * Tools whose output is **not** the user's own material.
 *
 * Screening exists because fetched content is untrusted input: a page can carry
 * text aimed at the agent reading it. Local files are deliberately excluded by
 * default — they are the user's own material, they are read far more often, and
 * screening them would spend the per-turn budget that pruning needs. A user who
 * clones untrusted repositories can add `read` themselves.
 */
export const DEFAULT_SCREEN_ALLOWLIST = ['web_fetch', 'web_search']

/** Resolved settings shape, mirroring {@link Config}. */
export interface JevSettings {
  /** Master switch. Off means both capabilities are inert, exactly like a missing key. */
  enabled: boolean
  /** Environment-variable name the key is resolved from, re-resolved on every operation. */
  apiKeyEnv: string
  /** Jev model id, an alias or a pinned version. The response's own `model` is what gets recorded. */
  model: string
  /** Hard ceiling on judgments per session, across every capability. */
  sessionCallLimit: number
  prune: {
    enabled: boolean
    /** Estimated-token floor below which a result is not worth judging. */
    minTokens: number
    /** Per-turn judgment ceiling. Measured: uncapped worst turn was 27 triggers ≈ 8.1s. */
    perTurnLimit: number
    toolAllowlist: string[]
    /** Deterministic floor: leading lines always kept. */
    headLines: number
    /** Deterministic floor: trailing lines always kept. */
    tailLines: number
    /** Probability at or above which a segment is kept unconditionally. */
    keepHigh: number
    /** Never reduce a result below this share of its original size. */
    minKeepRatio: number
    /** Give up (return the original) when the achievable saving is below this share. */
    minSaving: number
    /** Give up when the current request is shorter than this, in characters. */
    minTaskChars: number
    /**
     * Judge as usual but change nothing, so a user can see what pruning would
     * have removed before trusting it with their context.
     */
    shadow: boolean
  }
  suggest: {
    enabled: boolean
    /** Only suggest when the catalog is at least this large. Measured: p50 was 29. */
    minCatalogSize: number
    /** Below this probability, stay silent rather than add noise. */
    minConfidence: number
  }
  screen: {
    enabled: boolean
    /** Below this estimated token count there is not enough text to carry an injection. */
    minTokens: number
    /** Injection probability at or above which an advisory warning is attached. */
    threshold: number
    toolAllowlist: string[]
  }
  ledger: {
    enabled: boolean
  }
}

/**
 * Composition-entry schema.
 *
 * Also the declaration a configuration surface dispatches on: a settings card
 * renders from this schema, so every field carries a user-facing description.
 */
export const Config = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .description('总开关。关闭后两项自动能力完全失效——与"未配置 key"行为一致，不发任何网络请求。'),
  apiKeyEnv: Schema.string()
    .default(DEFAULT_API_KEY_ENV)
    .description(`读取 API key 的环境变量名。默认 ${DEFAULT_API_KEY_ENV}（与 TypeSafe 官方 SDK 相同，已在使用官方工具链的人无需配置）。密钥本身永远不会出现在任何响应里。`),
  model: Schema.string()
    .default('jev-latest')
    .description('使用的 Jev 模型。别名会随版本移动——每次判定都会记录响应里回报的实际作答版本。'),
  sessionCallLimit: Schema.number()
    .default(200)
    .description('单个会话的最大判定次数（所有能力合计）。超出后原样放行并给出说明，不会静默。'),

  prune: Schema.object({
    enabled: Schema.boolean().default(true)
      .description('自动剪掉工具结果中与当前任务无关的部分。'),
    minTokens: Schema.number().default(2000)
      .description('只判定超过这个估算 token 数的工具结果。实测：2000 可省下约 32% 的工具结果 token，同时避开"省得少却照样花 300ms"的边际区间。'),
    perTurnLimit: Schema.number().default(3)
      .description('单个 turn 内的剪枝次数上限。实测：不设上限时最坏一个 turn 会触发 27 次（约 8.1 秒）；限 3 次后最坏 0.9 秒。'),
    toolAllowlist: Schema.array(Schema.string()).default([...DEFAULT_TOOL_ALLOWLIST])
      .description('参与剪枝的工具白名单。刻意不含 pwsh——终端输出里的"无关"内容往往是排查所需。'),
    headLines: Schema.number().default(40)
      .description('确定性保底：结果开头的行数永远保留。'),
    tailLines: Schema.number().default(40)
      .description('确定性保底：结果结尾的行数永远保留。'),
    keepHigh: Schema.number().default(0.5)
      .description('相关概率达到此值的片段无条件保留。'),
    minKeepRatio: Schema.number().default(0.2)
      .description('削减下限：任何结果都不会被压到这个比例以下，防止削成空壳。'),
    minSaving: Schema.number().default(0.15)
      .description('若可达削减比例低于此值则放弃剪枝、原样返回——不值得为这点收益引入失真。'),
    minTaskChars: Schema.number().default(12)
      .description('当前任务文本短于此长度时放弃剪枝。实测发现：拿「继续吧」这类极短消息去判相关性，结果基本是噪声——与其用无信息量的任务乱裁，不如不动。'),
    shadow: Schema.boolean().default(false)
      .description('试运行：照常判定与记账，但不真的改动内容，只告诉你"本来会削掉多少、留下什么"。用来在信任剪枝之前先看清它的取舍——判定成本照付，上下文一个字不改。'),
  }).description('工具结果语义剪枝'),

  suggest: Schema.object({
    enabled: Schema.boolean().default(true)
      .description('当技能目录较大时，每轮至多推荐一个 skill（仅建议，不会替你决定）。'),
    minCatalogSize: Schema.number().default(15)
      .description('技能数量达到此值才启用推荐。实测典型目录有 29 个 skill，此阈值对真实用户必触发、对极简配置保持沉默。'),
    minConfidence: Schema.number().default(0.3)
      .description('最高概率低于此值时不注入任何建议——宁可沉默，不要噪音。'),
  }).description('技能推荐'),

  screen: Schema.object({
    enabled: Schema.boolean().default(true)
      .description('检查抓取到的外部内容里是否有针对 AI 的注入指令（提示注入）。只做提醒，绝不阻断、绝不改写内容。'),
    minTokens: Schema.number().default(300)
      .description('低于此估算 token 数不做注入筛查——太短的文本承载不了注入指令。'),
    threshold: Schema.number().default(0.75)
      .description('注入概率达到此值时附加一条提醒。判定是建议性的：插件不会替你拦截任何内容。'),
    toolAllowlist: Schema.array(Schema.string()).default([...DEFAULT_SCREEN_ALLOWLIST])
      .description('参与注入筛查的工具。默认只查外部抓取（web_fetch / web_search）——本地文件是你自己的材料，且读取频繁。克隆不受信仓库的人可以自己加上 read。'),
  }).description('注入筛查（仅提醒）'),

  ledger: Schema.object({
    enabled: Schema.boolean().default(true)
      .description('把每次判定记入本地台账。台账是校准阈值、核算成本与验证削减效果的唯一依据，建议保持开启。关闭后台账不再记录，/jev-status 会显示"已关闭"。'),
  }).description('判定台账'),
})

/**
 * Resolve a raw composition entry against the schema.
 *
 * `apply` receives whatever the patch declared, which may be `undefined` when
 * the row carries no `config:`. Calling the schema applies every default.
 *
 * @param entry - the raw composition entry config.
 * @returns the fully resolved settings.
 */
export function resolveSettings (entry: unknown): JevSettings {
  return Config(entry ?? {}) as JevSettings
}
