/**
 * Print the GitHub Release body for one version.
 *
 * Used by the release workflow after npm has accepted the publish, and runnable
 * by hand:
 *
 *   node scripts/release-notes.ts 0.1.7
 *
 * It exits non-zero when the default-language changelog has no section for the
 * version, because that would create a release that says nothing — and a release
 * with an empty body is worse than a red workflow, since nobody sees it fail.
 *
 * @module dsh-jev-tools/scripts/release-notes
 */

import fs from 'node:fs'

import { composeReleaseBody, sectionOf } from './lib/release-notes.ts'

const version = process.argv[2]

if (version === undefined || version === '') {
  console.error('usage: node scripts/release-notes.ts <version>   (for example: 0.1.7)')
  process.exit(2)
}

/** Read a file from the repository root, as UTF-8. */
function read (name: string): string {
  return fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
}

const primary = sectionOf(read('CHANGELOG.md'), version)
if (primary === undefined) {
  console.error(`CHANGELOG.md has no "## [${version}]" section — refusing to write an empty release body`)
  process.exit(1)
}

const english = sectionOf(read('CHANGELOG.en.md'), version)
if (english === undefined) {
  // Not fatal: the release still carries the default side. It is worth a warning
  // because the two files are meant to be peers.
  console.error(`warning: CHANGELOG.en.md has no "## [${version}]" section; the release will be one-sided`)
}

const manifest = JSON.parse(read('package.json')) as {
  name: string
  repository: { url: string }
}

process.stdout.write(composeReleaseBody({
  version,
  packageName: manifest.name,
  repository: manifest.repository.url,
  primary,
  ...(english === undefined ? {} : { english }),
}))
