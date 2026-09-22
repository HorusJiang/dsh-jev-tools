/**
 * The release body, and the one thing that could silently make it empty.
 *
 * A release is created after npm has already accepted the publish, so a body
 * built from a changelog section that does not exist would ship an announcement
 * with nothing in it — and unlike a failed publish, nothing would look wrong.
 * The last test here ties the version in `package.json` to a section in both
 * changelog sides, so that gap is caught in the suite rather than in a release.
 *
 * @module dsh-jev-tools/test/release-notes
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'

import { browseUrl, composeReleaseBody, sectionOf } from '../scripts/lib/release-notes.ts'

const CHANGELOG = `# 更新日志

[English](CHANGELOG.en.md) | 中文

## 版本现状

| 版本 | 日期 |
|---|---|
| \`0.2.0\` | 2026-10-01 |

## [0.2.0] — 2026-10-01

### Added

- 第二条

## [0.1.0] — 2026-09-20

### Added

- 第一条
`

test('a section is the body under its heading, and stops at the next version', () => {
  const section = sectionOf(CHANGELOG, '0.2.0')
  assert.ok(section !== undefined, 'expected a section for 0.2.0')
  assert.match(section.heading, /^## \[0\.2\.0\]/)
  assert.match(section.body, /第二条/)
  // The previous release, and the version table above it, must stay out.
  assert.doesNotMatch(section.body, /第一条/)
  assert.doesNotMatch(section.body, /版本现状/)
})

test('a version with no section is not a release', () => {
  assert.equal(sectionOf(CHANGELOG, '9.9.9'), undefined)
  // A heading that is not a version must not be mistaken for one.
  assert.equal(sectionOf(CHANGELOG, '版本现状'), undefined)
})

test('the manifest repository value becomes a browsable URL', () => {
  assert.equal(
    browseUrl('git+https://github.com/HorusJiang/dsh-jev-tools.git'),
    'https://github.com/HorusJiang/dsh-jev-tools'
  )
  assert.equal(browseUrl('https://github.com/a/b'), 'https://github.com/a/b')
})

test('the body carries both language sides and the install line', () => {
  const body = composeReleaseBody({
    version: '0.2.0',
    packageName: 'dsh-jev-tools',
    repository: 'git+https://github.com/HorusJiang/dsh-jev-tools.git',
    primary: { heading: '## [0.2.0]', body: '### Added\n\n- 中文条目' },
    english: { heading: '## [0.2.0]', body: '### Added\n\n- the English entry' },
  })
  // Two peers, not an original and a summary.
  assert.match(body, /中文条目/)
  assert.match(body, /the English entry/)
  assert.match(body, /\*\*English\*\*/)
  assert.match(body, /npm i dsh-jev-tools@0\.2\.0/)
  assert.match(body, /blob\/main\/CHANGELOG\.en\.md/)
})

test('a one-sided body is still a body', () => {
  const body = composeReleaseBody({
    version: '0.2.0',
    packageName: 'dsh-jev-tools',
    repository: 'https://github.com/a/b',
    primary: { heading: '## [0.2.0]', body: '### Added\n\n- only one side' },
  })
  assert.match(body, /only one side/)
  assert.doesNotMatch(body, /\*\*English\*\*/)
})

test('the version package.json declares has a section in both changelog sides', () => {
  // This is the check that keeps a release from being created empty: it fails
  // here, where the message names the file to edit, instead of in the release job
  // after the package is already on npm.
  const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  const primary = sectionOf(fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'), manifest.version)
  const english = sectionOf(fs.readFileSync(new URL('../CHANGELOG.en.md', import.meta.url), 'utf8'), manifest.version)
  assert.ok(primary !== undefined, `CHANGELOG.md has no section for ${manifest.version}`)
  assert.ok(english !== undefined, `CHANGELOG.en.md has no section for ${manifest.version}`)
  assert.ok(primary.body.length > 0, `the ${manifest.version} section of CHANGELOG.md is empty`)
  assert.ok(english.body.length > 0, `the ${manifest.version} section of CHANGELOG.en.md is empty`)
})
