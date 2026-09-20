/**
 * Durable-ledger reader tests.
 *
 * Measurement is only worth anything if it reads exactly what the writer wrote,
 * so this file drives the real on-disk layout — one document per record under
 * `<root>/<domain>/<table>/<key>.json` — including the two document classes the
 * writer's own contract discards.
 *
 * @module dsh-jev-tools/test/ledger-files
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { defaultStorageRoot, ledgerDomainDir, readLedgerRecords } from '../scripts/lib/ledger-files.ts'
import { JUDGMENTS_TABLE, LEDGER_DOMAIN_NAME, LEDGER_DOMAIN_VERSION, TOTALS_KEY, TOTALS_TABLE } from '../lib/ledger-domain.js'
import type { JudgmentRecord } from '../lib/ledger.js'

/** A temporary storage root, removed when `body` returns. */
function withStorageRoot (body: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-ledger-'))
  try {
    body(root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

/** Write one per-record document in the writer's own format. */
function writeDocument (file: string, record: unknown, version = LEDGER_DOMAIN_VERSION): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify({ version, record }, null, 2)}\n`, 'utf8')
}

/** A well-formed record. */
function record (overrides: Partial<JudgmentRecord> = {}): JudgmentRecord {
  return {
    ts: 1_700_000_000_000,
    agentId: 'agent-1',
    feature: 'prune',
    backendId: 'jev',
    model: 'jev-1.13.0',
    latencyMs: 120,
    outcome: 'judged',
    ...overrides,
  }
}

test('the reader reads the layout the writer produces, oldest first', () => {
  withStorageRoot(root => {
    const table = path.join(ledgerDomainDir(root), JUDGMENTS_TABLE)
    // Written out of order, as a directory scan may well hand them over.
    writeDocument(path.join(table, '0001700000000002-00000003.json'), record({ ts: 1_700_000_000_002, agentId: 'c' }))
    writeDocument(path.join(table, '0001700000000000-00000001.json'), record({ ts: 1_700_000_000_000, agentId: 'a' }))
    writeDocument(path.join(table, '0001700000000001-00000002.json'), record({ ts: 1_700_000_000_001, agentId: 'b' }))

    const snapshot = readLedgerRecords(ledgerDomainDir(root))
    assert.deepEqual(snapshot.records.map(entry => entry.agentId), ['a', 'b', 'c'])
    assert.deepEqual(snapshot.gaps, { unreadable: 0, foreignVersion: 0, invalidRecord: 0 })
    assert.equal(snapshot.totals, undefined)
  })
})

test('the reader reports the cumulative counters alongside the records', () => {
  withStorageRoot(root => {
    const domainDir = ledgerDomainDir(root)
    writeDocument(path.join(domainDir, JUDGMENTS_TABLE, '0001700000000000-00000001.json'), record())
    const totals = { records: 9, judged: 7, skipped: 2, savedTokens: 1_000, baselineSavedTokens: 400, netTokens: 600 }
    writeDocument(path.join(domainDir, TOTALS_TABLE, `${TOTALS_KEY}.json`), totals)

    const snapshot = readLedgerRecords(domainDir)
    assert.equal(snapshot.records.length, 1)
    assert.deepEqual(snapshot.totals, totals)
  })
})

test('a document class the writer discards is counted, never fatal', () => {
  withStorageRoot(root => {
    const domainDir = ledgerDomainDir(root)
    const table = path.join(domainDir, JUDGMENTS_TABLE)
    writeDocument(path.join(table, '0000000000001000-00000001.json'), record({ ts: 1_000 }))
    // A stale version stamp: `per-record` discards it rather than migrating.
    writeDocument(path.join(table, '0000000000002000-00000002.json'), record({ ts: 2_000 }), LEDGER_DOMAIN_VERSION + 1)
    // A value the record schema cannot vouch for.
    writeDocument(path.join(table, '0000000000003000-00000003.json'), { ts: 3_000, agentId: 'corrupt' })
    // Not JSON at all.
    fs.writeFileSync(path.join(table, '0000000000004000-00000004.json'), '{ truncated', 'utf8')
    // A backed-up document: renamed, so it no longer ends in `.json`.
    writeDocument(path.join(table, '0000000000005000-00000005.json.bak.202601011200'), record({ ts: 5_000 }))
    // An unrelated file the backend would also ignore.
    fs.writeFileSync(path.join(table, 'README'), 'not a document', 'utf8')

    const snapshot = readLedgerRecords(domainDir)
    assert.deepEqual(snapshot.records.map(entry => entry.ts), [1_000])
    assert.deepEqual(snapshot.gaps, { unreadable: 1, foreignVersion: 1, invalidRecord: 1 })
  })
})

test('a missing ledger explains why it may legitimately be missing', () => {
  withStorageRoot(root => {
    assert.throws(
      () => readLedgerRecords(ledgerDomainDir(root)),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /no ledger found/)
        // The reader must not leave the user guessing whether the plugin is broken.
        assert.match(error.message, /jev-status/)
        return true
      }
    )
  })
})

test('the default storage root follows DSH_HOME', () => {
  const previous = process.env['DSH_HOME']
  try {
    process.env['DSH_HOME'] = path.join('C:', 'somewhere', '.dsh')
    assert.equal(defaultStorageRoot(), path.join('C:', 'somewhere', '.dsh', 'storages'))
    assert.equal(ledgerDomainDir(), path.join('C:', 'somewhere', '.dsh', 'storages', LEDGER_DOMAIN_NAME))
  } finally {
    if (previous === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = previous
  }
})

test('an unreadable counters row is absent rather than fatal', () => {
  withStorageRoot(root => {
    const domainDir = ledgerDomainDir(root)
    writeDocument(path.join(domainDir, JUDGMENTS_TABLE, '0000000000001000-00000001.json'), record({ ts: 1_000 }))
    fs.mkdirSync(path.join(domainDir, TOTALS_TABLE), { recursive: true })
    fs.writeFileSync(path.join(domainDir, TOTALS_TABLE, `${TOTALS_KEY}.json`), '{ "version": 1 }', 'utf8')
    const snapshot = readLedgerRecords(domainDir)
    assert.equal(snapshot.totals, undefined)
    assert.equal(snapshot.records.length, 1)
  })
})
