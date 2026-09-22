/**
 * Reading the durable ledger off the medium.
 *
 * The plugin writes its ledger through `storageDomain`, which routes to the
 * `storage-json` backend: a `per-record` unit is a directory,
 * `<storageRoot>/<domain>/<table>/<key>.json`, one document per record, each
 * holding `{ version, record }`. This module reads that tree directly, so
 * measurement does not need a running host — but it does need the writer's own
 * constants, which is why it imports them from `lib/ledger-domain.js` rather
 * than restating the domain name or the format version here. A reader that
 * hard-codes the format it reads is a reader that silently stops matching the
 * writer.
 *
 * Two document classes are deliberately skipped and counted rather than
 * reported as errors, because the writer's own contract discards them too:
 *
 *   - a document whose version stamp is not accepted — `per-record` scopes the
 *     version check per document, so a stale record reads as absent rather
 *     than being migrated;
 *   - a document whose value fails the record schema — `invalidRecords:
 *     'backup-and-skip'` moves it aside as `<key>.json.bak.<stamp>`, which no
 *     longer ends in `.json`, so a backed-up document never reaches this
 *     reader at all.
 *
 * @module scripts/lib/ledger-files
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { JUDGMENTS_TABLE, LEDGER_DOMAIN_NAME, LEDGER_DOMAIN_VERSION, TOTALS_KEY, TOTALS_TABLE, judgmentSchema, totalsSchema } from '../../lib/ledger-domain.js'
import type { JudgmentRecord } from '../../lib/ledger.js'

/** The counters row's shape, as the ledger declares it. */
export interface LedgerTotals {
  readonly records: number
  readonly judged: number
  readonly skipped: number
  readonly savedTokens: number
  readonly baselineSavedTokens: number
  readonly netTokens: number
  /** Optional: a row written before this counter existed does not carry it. */
  readonly spentTokens?: number
}

/** What the reader could not use, counted by reason. */
export interface LedgerGaps {
  /** The document was not JSON, or not an object. */
  readonly unreadable: number
  /** The document carries a version stamp this release does not accept. */
  readonly foreignVersion: number
  /** The document parsed but its value fails the record schema. */
  readonly invalidRecord: number
}

/** One read of the ledger tree. */
export interface LedgerSnapshot {
  /** Records, oldest first. */
  readonly records: JudgmentRecord[]
  readonly gaps: LedgerGaps
  /** The cumulative counters row, when it is present and readable. */
  readonly totals?: LedgerTotals
}

/** The base composition routes `storage-json` at `dshHomePath('storages')`. */
export function defaultStorageRoot (): string {
  const home = process.env['DSH_HOME'] ?? path.join(os.homedir(), '.dsh')
  return path.join(home, 'storages')
}

/** The domain's directory under a storage root. */
export function ledgerDomainDir (storageRoot: string = defaultStorageRoot()): string {
  return path.join(storageRoot, LEDGER_DOMAIN_NAME)
}

/**
 * Read one domain's ledger documents.
 *
 * @param domainDir - the domain's directory on the medium.
 * @returns the records in time order, what was skipped, and the counters.
 * @throws when the directory does not exist, with a message that says why it
 *   might legitimately be missing.
 */
export function readLedgerRecords (domainDir: string): LedgerSnapshot {
  const tableDir = path.join(domainDir, JUDGMENTS_TABLE)
  if (!fs.existsSync(tableDir)) {
    throw new Error(`no ledger found at ${tableDir}\n`
      + '  The plugin writes there only after a judgment has happened, and only when the\n'
      + '  profile provides storageDomain. Run /jev-status in a session: if it reports\n'
      + '  "memory only", the ledger is not being persisted and there is nothing to read.')
  }

  const parse = judgmentSchema().parse
  const records: JudgmentRecord[] = []
  let unreadable = 0
  let foreignVersion = 0
  let invalidRecord = 0

  // Sorting the names is what puts the history in time order: keys are
  // zero-padded timestamps, so lexicographic order is chronological order.
  for (const name of fs.readdirSync(tableDir).sort()) {
    // A backed-up document ends in `.bak.<stamp>`, not `.json`.
    if (!name.endsWith('.json')) continue
    let document: { version?: unknown, record?: unknown }
    try {
      document = JSON.parse(fs.readFileSync(path.join(tableDir, name), 'utf8')) as typeof document
    } catch {
      unreadable += 1
      continue
    }
    if (typeof document !== 'object' || document === null || document.version !== LEDGER_DOMAIN_VERSION) {
      foreignVersion += 1
      continue
    }
    try {
      records.push(parse(document.record))
    } catch {
      invalidRecord += 1
    }
  }

  const totals = readTotals(domainDir)
  return { records, gaps: { unreadable, foreignVersion, invalidRecord }, ...(totals === undefined ? {} : { totals }) }
}

/** Read the cumulative counters row, when it is present and readable. */
function readTotals (domainDir: string): LedgerTotals | undefined {
  const file = path.join(domainDir, TOTALS_TABLE, `${TOTALS_KEY}.json`)
  if (!fs.existsSync(file)) return undefined
  try {
    const document = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown, record?: unknown }
    if (document.version !== LEDGER_DOMAIN_VERSION) return undefined
    return totalsSchema().parse(document.record)
  } catch {
    return undefined
  }
}
