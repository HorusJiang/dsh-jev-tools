/**
 * Settings-namespace wiring.
 *
 * `installSection` attaches this plugin as one *optional* settings consumer:
 * the composition entry becomes the base layer while the settings provider is
 * present, and the same entry is the fallback if the provider detaches. The
 * values themselves are resolved by the provider; the section exists so a
 * configuration surface has a namespace and a schema to dispatch on.
 *
 * @module dsh-jev-tools/settings-ns
 */

import { Config, JEV_TOOLS_NS } from './config.js'
import type { PluginContext, ServiceScope } from './host.js'

/**
 * Register the settings section, tolerating a profile without the settings provider.
 *
 * @param ctx - the plugin context, used as the section owner.
 * @param entry - the composition entry, serving as base and fallback value.
 * @param onChange - called after a committed settings change; the plugin
 *   re-reads resolved values rather than trusting its own copy.
 */
export function installSettingsNamespace (
  ctx: PluginContext,
  entry: unknown,
  onChange: () => void
): void {
  ctx.inject(['settings'], (scope: ServiceScope) => {
    const settings = scope.settings
    if (settings === undefined) return
    try {
      settings.installSection(ctx, JEV_TOOLS_NS, Config, entry ?? {}, {
        // The composition entry is the section's only base layer, so there is
        // no second source to mirror; the hook exists to satisfy the contract.
        setSource: () => {},
        onChange: () => { onChange() },
      })
    } catch (error) {
      // A duplicate namespace fails loud in the seam, which is correct — but it
      // must not take the whole plugin down with it.
      ctx.logger?.warn('[dsh-jev-tools] settings section unavailable:', error)
    }
  })
}
