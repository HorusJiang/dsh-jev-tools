/**
 * The published artifact must load on the oldest Node `engines` promises.
 *
 * `package.json` says `>= 20`, and that claim is about the *shipped* files:
 * plain ES2023 JavaScript under `lib/`. The test suite is a different matter —
 * it is TypeScript, and Node only strips types by default from 24 (22.6 behind
 * `--experimental-strip-types`) — so "the suite ran on 24" says nothing about
 * whether a Node 20 consumer can load the package at all.
 *
 * This checks the part that claim is actually about: import the built entry,
 * and resolve the settings schema through it. It runs in CI on the floor
 * version, and locally as:
 *
 *   npm run build && node scripts/check-runtime.mjs
 *
 * @module scripts/check-runtime
 */

const index = await import('../lib/index.js')

if (typeof index.apply !== 'function') {
  throw new Error('lib/index.js does not export apply(), so the host cannot mount the plugin')
}
if (typeof index.name !== 'string') {
  throw new Error('lib/index.js does not export the plugin name the bundle patch mounts it as')
}

// The schema is the one thing every code path goes through, and it is also the
// only place a dependency (@deepseek-ai/schemastery) is imported at module
// scope — so resolving it proves the dependency graph loads, not just the entry.
const { DEFAULT_BASE_URL, Config, resolveSettings } = await import('../lib/config.js')
const settings = resolveSettings(undefined)
if (settings.model !== 'jev-latest' || settings.baseUrl !== DEFAULT_BASE_URL) {
  throw new Error(`the settings schema resolved to unexpected defaults: ${JSON.stringify(settings)}`)
}
if (typeof Config !== 'function') {
  throw new Error('Config is not callable, so a settings surface cannot render from it')
}

console.log(`the built entry imports and its schema resolves on ${process.version}`)
