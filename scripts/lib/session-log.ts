/**
 * Reader for DSH session logs.
 *
 * A `session.v*.jsonl.zstd` file is NOT a single zstd stream and NOT one frame
 * per record: the writer appends independent zstd frames, and each frame may
 * carry several newline-delimited JSON records. Node's zstd API stops after the
 * first frame, so a whole-file decompress yields only the header record.
 *
 * The reliable read is therefore: scan for the frame magic, decompress from each
 * candidate offset, split the decoded text into lines, and union the records by
 * `seq`. A magic byte sequence that occurs inside a compressed payload produces
 * either a decode error or a suffix/partial record that is dropped by the same
 * union, so coincidental hits cannot corrupt the result set.
 *
 * @module scripts/lib/session-log
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/** zstd frame magic `28 B5 2F FD`, read little-endian. */
const ZSTD_MAGIC_LE = 0xfd2fb528

/** One decoded session record. */
export interface SessionRecord {
  readonly type: string
  readonly seq?: number
  readonly time?: number
  readonly data?: unknown
}

/** The session header record (no `seq`). */
export interface SessionHeader extends SessionRecord {
  readonly type: 'session'
  readonly id: string
  readonly cwd?: string
}

/** A decoded log: header plus every record in `seq` order. */
export interface SessionLog {
  readonly file: string
  readonly header: SessionHeader | undefined
  readonly records: readonly SessionRecord[]
}

/** Stable identity for a record that carries no `seq`. */
function fallbackKey (record: SessionRecord): string {
  return `${record.type}::${JSON.stringify(record).slice(0, 512)}`
}

/**
 * Decode every frame in one session log file.
 *
 * @param file - absolute path to a `session.v*.jsonl.zstd` file.
 * @returns the header and the deduplicated, `seq`-ordered records.
 */
export function readSessionLog (file: string): SessionLog {
  const buf = fs.readFileSync(file)
  const bySeq = new Map<number, SessionRecord>()
  const unsequenced = new Map<string, SessionRecord>()
  let header: SessionHeader | undefined

  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf.readUInt32LE(i) !== ZSTD_MAGIC_LE) continue
    let text: string
    try {
      // `subarray` is a view, so this stays O(1) per candidate offset.
      text = zlib.zstdDecompressSync(buf.subarray(i)).toString('utf8')
    } catch {
      continue // a magic-shaped byte sequence inside a payload
    }
    for (const line of text.split('\n')) {
      if (line === '') continue
      let record: SessionRecord
      try {
        record = JSON.parse(line) as SessionRecord
      } catch {
        continue // a partial record produced by a mid-payload offset
      }
      if (record.type === 'session' && header === undefined) {
        header = record as SessionHeader
        continue
      }
      if (typeof record.seq === 'number') bySeq.set(record.seq, record)
      else unsequenced.set(fallbackKey(record), record)
    }
  }

  const records = [...bySeq.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(entry => entry[1])
  for (const record of unsequenced.values()) records.push(record)

  return { file, header, records }
}

/** Locate every session log under a DSH home directory. */
export function findSessionLogs (dshHome: string): string[] {
  const root = path.join(dshHome, 'sessions')
  const found: string[] = []
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/^session\.v\d+\.jsonl\.zstd$/.test(entry.name)) found.push(full)
    }
  }
  walk(root)
  return found
}
