/**
 * The bilingual documentation contract, enforced.
 *
 * Two user-facing documents are each maintained as **three sibling files** — an
 * unsuffixed `foo.md`, a language-suffixed `foo.<lang>.md`, and a consistency
 * record `foo.i18n.yaml` — following the harness's own convention (see
 * `docs/i18n/README.md` in the DSH checkout). The two prose sides are peers: the
 * suffixed file is a full translation rather than a summary, and the checks below
 * treat them symmetrically.
 *
 * Here that is `README.md` (Chinese) plus `README.en.md` (English), and the same
 * for the CHANGELOG. The two filenames are read out of the consistency record
 * rather than assumed, so the layout is not baked into this file.
 *
 * What is checked:
 *
 *   1. every pair is complete and its record names real files;
 *   2. the recorded blob hashes match the files as they are right now, so
 *      editing one side without re-confirming the pair goes red;
 *   3. each side carries its language switcher;
 *   4. the two sides have the same **structural signature** — heading depths in
 *      order, list item counts, table shapes, code fences, and link targets;
 *   5. each side's in-document anchors resolve against its own headings;
 *   6. any test count stated in prose matches the tests that exist;
 *   7. no paired document links to a file that is git-ignored.
 *
 * What it cannot do is stated plainly, because the limit matters: **a green run
 * means the pair was consistent at these exact contents, not that the two sides
 * say the same thing.** Checking that the translation is faithful, well-termed
 * and natural is the reviewer's half, and no hash can do it.
 *
 * The blob hashes are computed here rather than shelled out to `git`, so the
 * check needs no repository — which this checkout is not.
 *
 * @module dsh-jev-tools/test/docs
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** One document pair, named exactly as its consistency record names it. */
interface Pair {
  /** The record's own path. */
  readonly record: string
  /** The default-language side — Chinese here. */
  readonly primary: string
  /** The selectable side — English here. */
  readonly english: string
  /** Basenames, for building the switcher links. */
  readonly primaryName: string
  readonly englishName: string
}

/**
 * The blob hash git would give this content, computed without git.
 *
 * Line endings are normalised first. The recorded hashes describe the content in
 * the repository, which `.gitattributes` pins to LF — but a contributor whose
 * `core.autocrlf` is on would otherwise see every pair reported as edited, from a
 * working copy they never touched. The check should fail for document reasons,
 * not for platform ones.
 */
function blobHash (text: string): string {
  const body = Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8')
  return createHash('sha1')
    .update(`blob ${body.length}\0`, 'utf8')
    .update(body)
    .digest('hex')
}

/** The `name: hash` entries of a consistency record, in order. */
function recorded (recordPath: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of fs.readFileSync(recordPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const at = trimmed.indexOf(':')
    if (at < 0) continue
    map.set(trimmed.slice(0, at).trim(), trimmed.slice(at + 1).trim())
  }
  return map
}

/**
 * Every pair in the tree.
 *
 * The two filenames come from the record, and which one is English is decided by
 * its suffix — so `foo.md` + `foo.zh.md` and `foo.md` + `foo.en.md` are both
 * understood, and the record cannot disagree with the files it names.
 */
function pairs (): Pair[] {
  const found: Pair[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === '.npm-cache') continue
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.i18n.yaml')) continue
      const names = [...recorded(full).keys()]
      const englishName = names.find(name => /\.en\.md$/.test(name))
        ?? names.find(name => !/\.zh\.md$/.test(name))
        ?? 'MISSING-ENGLISH-SIDE'
      const primaryName = names.find(name => name !== englishName) ?? 'MISSING-DEFAULT-SIDE'
      found.push({
        record: full,
        primary: path.join(dir, primaryName),
        english: path.join(dir, englishName),
        primaryName,
        englishName,
      })
    }
  }
  walk(ROOT)
  return found
}

/** Both sides of a pair, for the checks that apply to each independently. */
function sides (pair: Pair): { readonly file: string, readonly label: string }[] {
  return [
    { file: pair.primary, label: pair.primaryName },
    { file: pair.english, label: pair.englishName },
  ]
}

/** The lines of a document outside fenced code. */
function prose (text: string): string[] {
  const out: string[] = []
  let fence = false
  for (const line of text.split('\n')) {
    if (/^```/.test(line)) { fence = !fence; continue }
    if (!fence) out.push(line)
  }
  return out
}

/**
 * Every link target in a document, markdown or HTML.
 *
 * HTML matters here: a README's banner is an `<img src>`, and a banner that the
 * package tarball does not carry is a broken image on the package page — the
 * same defect as a dead markdown link, reached by a different route.
 */
function linkTargets (text: string): string[] {
  const found: string[] = []
  for (const line of prose(text)) {
    for (const match of line.matchAll(/\]\(([^)\s]+)\)/g)) found.push(match[1]!)
    for (const match of line.matchAll(/(?:src|href)=["']([^"']+)["']/g)) found.push(match[1]!)
  }
  return found
}

/**
 * GitHub's heading anchor for a heading's text.
 *
 * Lowercased; punctuation dropped; runs of whitespace become a single hyphen.
 * Letters and digits include CJK, which is what keeps a Chinese heading's anchor
 * meaningful rather than empty.
 */
function slug (heading: string): string {
  return heading.trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-')
}

/** Every heading anchor a document defines, including blockquoted headings. */
function headingSlugs (text: string): Set<string> {
  const slugs = new Set<string>()
  for (const line of prose(text)) {
    const match = /^(?:>\s*)*#{1,6}\s+(.*)$/.exec(line)
    if (match !== null) slugs.add(slug(match[1]!))
  }
  return slugs
}

/** Every in-document anchor a document links to. */
function anchors (text: string): string[] {
  const found: string[] = []
  for (const line of prose(text)) {
    for (const match of line.matchAll(/\]\(#([^)\s]+)\)/g)) found.push(match[1]!)
  }
  return found
}

/**
 * The structural signature of a document.
 *
 * Deliberately not a parse tree: it records the things a translation can
 * silently break — a dropped list item, a table that lost a column, a code
 * block whose language tag changed, a link that was reworded into a different
 * target.
 */
function signature (text: string): string[] {
  const out: string[] = []
  let fence: string | undefined
  let list: { kind: string, indent: number, items: number } | undefined
  let table: { rows: number, cols: number } | undefined

  const flushList = (): void => {
    if (list !== undefined) out.push(`list:${list.kind}@${list.indent}x${list.items}`)
    list = undefined
  }
  const flushTable = (): void => {
    if (table !== undefined) out.push(`table:${table.rows}x${table.cols}`)
    table = undefined
  }

  for (const line of text.split('\n')) {
    const fenceMatch = /^```(\S*)/.exec(line)
    if (fenceMatch !== null) {
      if (fence === undefined) {
        flushList(); flushTable()
        fence = fenceMatch[1] ?? ''
        out.push(`code:${fence}`)
      } else {
        fence = undefined
      }
      continue
    }
    // Inside a fence, nothing counts: code is compared verbatim elsewhere.
    if (fence !== undefined) continue

    // Link targets are collected from every line, including a wrapped list item:
    // a link the counterpart does not carry is exactly what this catches. Two
    // normalisations apply, both by the contract rather than for convenience:
    // a paired document's two names collapse to one (whichever side is the
    // default links to `foo.md`, the other to `foo.en.md` or `foo.zh.md`), and
    // the fragment is dropped — an anchor points at a heading, and the headings
    // are translated, so `#v01-boundaries` and `#v01-的边界` are the same target.
    // That each side's anchors actually resolve is checked separately, against
    // its own headings.
    for (const match of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1]!.replace(/\.(?:en|zh)\.md(#|$)/, '.md$1').split('#')[0]!
      out.push(`link:${target}`)
    }

    const heading = /^(#{1,6})\s/.exec(line)
    if (heading !== null) {
      flushList(); flushTable()
      out.push(`h${heading[1]!.length}`)
      continue
    }

    // A table row, including the `|---|` separator, which is not a data row.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushList()
      const cols = line.trim().replace(/^\||\|$/g, '').split('|').length
      const isSeparator = /^[\s|:-]+$/.test(line)
      if (table === undefined) table = { rows: 0, cols }
      if (!isSeparator) table.rows += 1
      continue
    }
    flushTable()

    const item = /^(\s*)([-*+]|\d+\.)\s+/.exec(line)
    if (item !== null) {
      const kind = item[2]!.endsWith('.') ? 'ol' : 'ul'
      const indent = item[1]!.length
      if (list !== undefined && (list.kind !== kind || list.indent !== indent)) flushList()
      if (list === undefined) list = { kind, indent, items: 0 }
      list.items += 1
      continue
    }

    if (line.trim() === '') continue
    // An indented line continues the item above rather than starting a new
    // block. Without this, every wrapped list item becomes its own one-item
    // list, and the signature compares formatting instead of content.
    if (list !== undefined && /^\s{2,}\S/.test(line)) continue
    flushList()
  }
  flushList(); flushTable()
  return out
}

const ALL = pairs()

test('every pair is three complete sibling files', () => {
  assert.ok(ALL.length >= 2, 'expected at least the README and CHANGELOG pairs')
  for (const pair of ALL) {
    const label = path.relative(ROOT, pair.record).replaceAll('\\', '/')
    assert.ok(fs.existsSync(pair.primary), `${label} names ${pair.primaryName}, which does not exist`)
    assert.ok(fs.existsSync(pair.english), `${label} names ${pair.englishName}, which does not exist`)
    assert.notEqual(pair.primaryName, 'MISSING-DEFAULT-SIDE',
      `${label} must name both sides; it names ${pair.englishName} only`)
  }
})

test('the recorded hashes match the files as they are now', () => {
  for (const pair of ALL) {
    const dir = path.dirname(pair.record)
    const label = path.relative(ROOT, pair.record).replaceAll('\\', '/')
    for (const [name, assumed] of recorded(pair.record)) {
      const file = path.join(dir, name)
      assert.ok(fs.existsSync(file), `${label} records a hash for ${name}, which does not exist`)
      const actual = blobHash(fs.readFileSync(file, 'utf8'))
      assert.equal(actual, assumed,
        `${label}: ${name} has changed since the pair was last confirmed — bring the counterpart along `
        + 'and re-record the pair')
    }
  }
})

test('each side carries the language switcher', () => {
  for (const pair of ALL) {
    const label = path.relative(ROOT, pair.record).replaceAll('\\', '/')
    const primary = fs.readFileSync(pair.primary, 'utf8')
    const english = fs.readFileSync(pair.english, 'utf8')
    assert.ok(primary.includes(`[English](${pair.englishName})`),
      `${label}: the ${pair.primaryName} side must link to [English](${pair.englishName})`)
    assert.ok(english.includes(`[中文](${pair.primaryName})`),
      `${label}: the ${pair.englishName} side must link back to [中文](${pair.primaryName})`)
  }
})

test('the two sides have the same structural signature', () => {
  // A dropped list item, a table that lost a column, a link that was reworded
  // into a different target: all invisible to a hash, all caught here. Every
  // divergence is collected rather than failing on the first, so one run
  // produces the whole repair list.
  const divergences: string[] = []
  for (const pair of ALL) {
    const label = path.relative(ROOT, pair.record).replaceAll('\\', '/')
    const primary = signature(fs.readFileSync(pair.primary, 'utf8'))
    const english = signature(fs.readFileSync(pair.english, 'utf8'))
    if (primary.length !== english.length) {
      divergences.push(`${label}: ${pair.primaryName} has ${primary.length} structural elements, `
        + `${pair.englishName} has ${english.length}`)
    }
    for (let i = 0; i < Math.min(primary.length, english.length); i += 1) {
      if (primary[i] !== english[i]) {
        divergences.push(`${label}: at ${i} — ${pair.primaryName} has ${primary[i]}, `
          + `${pair.englishName} has ${english[i]}`)
      }
    }
  }
  assert.deepEqual(divergences, [], 'the two sides of a pair must mirror each other')
})

test('every in-document anchor resolves against that side\u2019s own headings', () => {
  // The structural check above deliberately ignores the fragment, because the
  // headings are translated. This is the other half: an anchor that points at a
  // heading which does not exist in *this* language is a dead link, and it is
  // exactly the kind of thing a translation breaks without noticing.
  for (const pair of ALL) {
    for (const side of sides(pair)) {
      const label = path.relative(ROOT, side.file).replaceAll('\\', '/')
      const text = fs.readFileSync(side.file, 'utf8')
      const defined = headingSlugs(text)
      for (const anchor of anchors(text)) {
        assert.ok(defined.has(anchor),
          `${label}: no heading produces the anchor #${anchor} (found: ${[...defined].join(', ')})`)
      }
    }
  }
})

test('no paired document links to a git-ignored file', () => {
  // A tracked document that points at an untracked one is a dead link for
  // everyone who clones the repository — and it looks perfectly fine locally,
  // which is what makes it worth a check.
  const patterns = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))
    .map(pattern => {
      const directory = pattern.endsWith('/')
      const body = pattern.replace(/\/$/, '')
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\u0000/g, '.*')
      return directory ? new RegExp(`(^|/)${body}(/|$)`) : new RegExp(`(^|/)${body}$`)
    })

  const dead: string[] = []
  for (const pair of ALL) {
    for (const side of sides(pair)) {
      const label = path.relative(ROOT, side.file).replaceAll('\\', '/')
      for (const target of linkTargets(fs.readFileSync(side.file, 'utf8'))) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue
        if (patterns.some(pattern => pattern.test(target))) dead.push(`${label} -> ${target}`)
      }
    }
  }
  assert.deepEqual(dead, [], 'these links point at files that are not in the repository')
})

test('a CRLF working copy does not break the recorded hashes', () => {
  // `core.autocrlf=true` is the default for many Windows installs, and it rewrites
  // the whole working copy on checkout. Without this normalisation a fresh clone
  // reports every pair as out of sync — fifteen red tests for a platform setting.
  const lf = 'line one\nline two\n'
  assert.equal(blobHash(lf.replace(/\n/g, '\r\n')), blobHash(lf))
})

test('every claim about the test count matches the tests that exist', () => {
  // A hardcoded count in prose rots: this one drifted four times while the
  // plugin was being written (136 → 160 → 183 → 189), and each time the docs
  // were briefly lying. Counting the tests and checking every claim turns a
  // number that always rots into one that cannot.
  //
  // The convention this creates: a document may state the test count only for
  // the *current* version. A changelog entry for an older release must not
  // quote one, because it would be a claim about the present.
  const tests = fs.readdirSync(path.join(ROOT, 'test'))
    .filter(name => name.endsWith('.test.ts'))
    .flatMap(name => [...fs.readFileSync(path.join(ROOT, 'test', name), 'utf8').matchAll(/^test\(/gm)])
    .length
  assert.ok(tests > 0, 'no tests were found to count')

  const claims: string[] = []
  for (const pair of ALL) {
    for (const side of sides(pair)) {
      const label = path.relative(ROOT, side.file).replaceAll('\\', '/')
      const text = fs.readFileSync(side.file, 'utf8')
      for (const match of text.matchAll(/(\d{2,4})\s*(?:tests?\b|个测试)/g)) {
        if (Number(match[1]) !== tests) {
          claims.push(`${label}: claims ${match[1]} tests, but ${tests} exist`)
        }
      }
    }
  }
  assert.deepEqual(claims, [])
})

test('every relative link in a paired document points at something published', () => {
  // The previous check covers git. This one covers the *other* surface a README
  // is read on: the npm package page, which renders README.md out of the tarball.
  // A relative link to a file `files` does not carry is a dead link there — and
  // again, perfectly fine locally.
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    files?: string[]
  }
  const published = manifest.files ?? []
  const isPublished = (target: string): boolean => published.some(entry =>
    entry.endsWith(target) || (!path.extname(entry) && target.startsWith(`${entry}/`)))

  const dead: string[] = []
  for (const pair of ALL) {
    for (const side of sides(pair)) {
      const label = path.relative(ROOT, side.file).replaceAll('\\', '/')
      for (const target of linkTargets(fs.readFileSync(side.file, 'utf8'))) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue
        if (!isPublished(target)) dead.push(`${label} -> ${target} (not in package.json "files")`)
      }
    }
  }
  assert.deepEqual(dead, [], 'these links would be dead on the package page')
})
