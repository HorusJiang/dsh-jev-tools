/**
 * A release body, built from the changelog that already exists.
 *
 * The changelog is the honest source for this. It is written before the release,
 * it is what a reader is pointed at, and it says *why* a change was made. GitHub's
 * generated notes would be a second, thinner account of the same release, and for
 * this project they would drop the measured numbers that make the entries worth
 * reading in the first place.
 *
 * Both language sides go in. `CHANGELOG.md` is the default side and `CHANGELOG.en.md`
 * is a full peer rather than a summary (see `docs/dev-workflow.md` §11), so a
 * release body carrying only one of them would be the first place in the project
 * where the other was treated as secondary.
 *
 * @module dsh-jev-tools/scripts/lib/release-notes
 */

/** One version's section of a changelog. */
export interface ChangelogSection {
  /** The `## [x.y.z] — date` heading line itself. */
  readonly heading: string
  /** Everything under it, up to the next `## ` heading. */
  readonly body: string
}

/**
 * Find one version's section.
 *
 * The section ends at the next level-2 heading, which is what keeps the version
 * table at the top of the file and the following releases out of the body.
 *
 * @param changelog - the whole file.
 * @param version - the version to look for, without a leading `v`.
 * @returns the section, or `undefined` when the file has none.
 */
export function sectionOf (changelog: string, version: string): ChangelogSection | undefined {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^## \\[${escaped}\\]`)
  const lines = changelog.split('\n')
  const start = lines.findIndex(line => pattern.test(line))
  if (start < 0) return undefined

  let end = lines.length
  for (let at = start + 1; at < lines.length; at += 1) {
    if (lines[at]!.startsWith('## ')) {
      end = at
      break
    }
  }
  return {
    heading: lines[start]!.trim(),
    body: lines.slice(start + 1, end).join('\n').trim(),
  }
}

/**
 * Turn a `package.json` repository value into a browsable URL.
 *
 * `git+https://github.com/owner/repo.git` is the form npm writes; a release body
 * needs the form a browser can open.
 *
 * @param repository - the manifest's `repository.url`.
 * @returns an https URL without the `.git` suffix.
 */
export function browseUrl (repository: string): string {
  return repository
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/^git:\/\//, 'https://')
}

/** Everything {@link composeReleaseBody} needs. */
export interface ReleaseBodyInput {
  readonly version: string
  readonly packageName: string
  /** The manifest's `repository.url`. */
  readonly repository: string
  /** The default-language side. Required: it is the release's own voice. */
  readonly primary: ChangelogSection
  /** The English side, when the file has that section. */
  readonly english?: ChangelogSection
}

/**
 * Compose the markdown a GitHub Release carries.
 *
 * @param input - the version, the two sections, and where to point readers.
 * @returns the body, newline-terminated.
 */
export function composeReleaseBody (input: ReleaseBodyInput): string {
  const base = browseUrl(input.repository)
  const parts = [input.primary.body]

  if (input.english !== undefined) {
    parts.push('---', '**English**', input.english.body)
  }

  parts.push(
    '---',
    `\`npm i ${input.packageName}@${input.version}\` · `
    + `[CHANGELOG.md](${base}/blob/main/CHANGELOG.md) · `
    + `[CHANGELOG.en.md](${base}/blob/main/CHANGELOG.en.md)`
  )
  return `${parts.join('\n\n')}\n`
}
