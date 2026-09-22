/**
 * What `npm publish` would actually upload, checked rather than trusted.
 *
 * `files` in package.json is an allowlist, and an allowlist is a control only
 * for as long as nobody widens it. This repository has two things that must
 * never ride along:
 *
 *   - `.npm-cache/` — the local package cache this project installs through
 *     (see the README), which is tens of megabytes of someone else's tarballs;
 *   - `trigger-rate.json` — a local measurement of this author's session logs.
 *
 * Neither is in `files`, so neither should be in the tarball. This asserts it
 * against the real `npm pack` output instead of against the intention, and it
 * also asserts that the files a consumer needs are *present*: an allowlist that
 * silently stops matching is the same failure from the other side.
 *
 * Runs in CI before a publish, and locally as:
 *
 *   node scripts/check-tarball.mjs
 *
 * @module scripts/check-tarball
 */

import { execSync } from 'node:child_process'

/** Local state and development material that must not ship. */
const FORBIDDEN = [
  /^\.npm-cache\//u,
  /^notes\//u,
  /^test\//u,
  /^scripts\//u,
  /^node_modules\//u,
  /^\.tmp/u,
  /^trigger-rate\.json$/u,
  /(^|\/)\.env/u,
  /\.log$/u,
]

/** What a consumer needs the tarball to carry. */
const REQUIRED = [
  'package.json',
  'lib/index.js',
  'lib/index.d.ts',
  'cordis.patch.yml',
  'client/client.js',
  'README.md',
  'README.en.md',
  'CHANGELOG.md',
  'LICENSE',
]

// A literal command through the shell on purpose, not `execFileSync`: npm is
// `npm.cmd` on Windows, which `execFileSync` cannot resolve — and a check that
// only runs on the runner is a check nobody can reproduce locally.
const raw = JSON.parse(execSync('npm pack --dry-run --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))

// npm 11 returns an array of results; npm 12 an object keyed by package name.
// Report an unrecognised shape rather than dying on a destructuring error.
const packed = Array.isArray(raw) ? raw[0] : Object.values(raw)[0]
if (packed === undefined || !Array.isArray(packed.files)) {
  console.error(`unexpected npm pack --json shape: ${JSON.stringify(raw).slice(0, 200)}`)
  process.exit(1)
}

const paths = packed.files.map(file => file.path)
const leaked = paths.filter(path => FORBIDDEN.some(pattern => pattern.test(path)))
const missing = REQUIRED.filter(required => !paths.includes(required))

console.log(`${packed.name}@${packed.version}: ${paths.length} files, ${(packed.size / 1024).toFixed(0)} KB packed`)

if (missing.length > 0) {
  console.error(`the tarball is missing files a consumer needs: ${missing.join(', ')}`)
  process.exit(1)
}
if (leaked.length > 0) {
  console.error(`the tarball carries local state: ${leaked.join(', ')}`)
  process.exit(1)
}
console.log('ok: nothing local, nothing missing')
