/**
 * Fast load of the ClickHouse HN dump:
 * fetch → unzip → parallel COPY (no search_tsv / no indexes) → generated
 * column → btree/trgm indexes. BM25 is opt-in (`--bm25`).
 *
 *   npm run db:seed
 *   npm run db:seed -- --streams=8 --batch=20000
 */

import { parse } from 'csv-parse'
import { parse as parseSync } from 'csv-parse/sync'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, open, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { finished } from 'node:stream/promises'
import pLimit from 'p-limit'
import { Client } from 'pg'
import { from as copyFrom } from 'pg-copy-streams'
import { describeUrl, unpooledUrl } from './env'

const DATASET_URL = 'https://datasets-documentation.s3.eu-west-3.amazonaws.com/hackernews/hacknernews.csv.gz'
const DATA_DIR = path.join(process.cwd(), 'data')
const GZ_PATH = path.join(DATA_DIR, 'hacknernews.csv.gz')
const CSV_PATH = path.join(DATA_DIR, 'hacknernews.csv')
const CHECKPOINT = path.join(DATA_DIR, 'seed-checkpoint.json')

const COLUMNS = ['id', 'deleted', 'type', 'by', 'time', 'text', 'dead', 'parent', 'poll', 'kids', 'url', 'score', 'title', 'parts', 'descendants'] as const
const ALLOWED_TYPES = new Set(['story', 'comment', 'poll', 'pollopt', 'job'])

const SEARCH_TSV_SQL = `to_tsvector(
  'english',
  coalesce(title, '') || ' ' || coalesce("by", '') || ' ' ||
  coalesce(regexp_replace(text, '<[^>]+>', ' ', 'g'), '')
)`

const INDEX_SQL = `
CREATE INDEX IF NOT EXISTS items_type_time_idx ON items (type, time DESC);
CREATE INDEX IF NOT EXISTS items_type_score_idx ON items (type, score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS items_parent_idx ON items (parent);
CREATE INDEX IF NOT EXISTS items_by_time_idx ON items ("by", time DESC);
CREATE INDEX IF NOT EXISTS items_title_trgm_idx ON items USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS items_by_trgm_idx ON items USING gin ("by" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS items_story_new_idx ON items (time DESC)
  WHERE type = 'story' AND NOT deleted AND NOT dead AND title IS NOT NULL AND title <> '';
CREATE INDEX IF NOT EXISTS items_titled_time_idx ON items (time DESC)
  WHERE NOT deleted AND NOT dead AND title IS NOT NULL AND title <> '';
`

// BM25 indexes are opt-in (--bm25): the full corpus index plus per-type partial
// indexes whose predicates match the app's WHERE clauses.
const BM25_SQL = `
CREATE INDEX IF NOT EXISTS items_search_gin ON items USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS items_search_bm25 ON items USING lakebase_bm25 (search_tsv);
CREATE INDEX IF NOT EXISTS items_story_bm25 ON items USING lakebase_bm25 (search_tsv)
  WHERE type = 'story' AND NOT deleted AND NOT dead;
CREATE INDEX IF NOT EXISTS items_comment_bm25 ON items USING lakebase_bm25 (search_tsv)
  WHERE type = 'comment' AND NOT deleted AND NOT dead;
CREATE INDEX IF NOT EXISTS items_job_bm25 ON items USING lakebase_bm25 (search_tsv)
  WHERE type = 'job' AND NOT deleted AND NOT dead;
`

const CREATE_SQL = `
CREATE EXTENSION IF NOT EXISTS lakebase_text;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
DROP TABLE IF EXISTS items CASCADE;
CREATE TABLE items (
  id bigint NOT NULL,
  deleted boolean NOT NULL DEFAULT false,
  type text NOT NULL,
  "by" text,
  time timestamptz,
  text text,
  dead boolean NOT NULL DEFAULT false,
  parent bigint,
  poll bigint,
  kids bigint[] NOT NULL DEFAULT '{}'::bigint[],
  url text,
  score integer,
  title text,
  parts bigint[] NOT NULL DEFAULT '{}'::bigint[],
  descendants integer
);
`

const args = process.argv.slice(2)
const withBm25 = args.includes('--bm25')
const forceDownload = args.includes('--force-download')
const skipDownload = args.includes('--skip-download')
const skipUnzip = args.includes('--skip-unzip')
const limit = Number(args.find((arg) => arg.startsWith('--limit='))?.slice('--limit='.length) ?? 0)
const BATCH = Math.max(1, Number(args.find((arg) => arg.startsWith('--batch='))?.slice('--batch='.length) ?? 20000))
const CONNECTIONS = Math.max(2, Math.min(32, Number(args.find((arg) => arg.startsWith('--connections='))?.slice('--connections='.length) ?? 16)))
const requestedStreams = Math.max(1, Math.min(16, Number(args.find((arg) => arg.startsWith('--streams='))?.slice('--streams='.length) ?? 8)))

type RangeState = { start: number; end: number; processed: number; inserted: number }
type Checkpoint = {
  version: 2
  streams: number
  fileSize: number
  ranges: RangeState[]
  phase: 'copy' | 'generated' | 'indexes' | 'done'
  processed?: number
  inserted?: number
  done?: boolean
}

function which(bin: string) {
  return new Promise<string | null>((resolve) => {
    const child = spawn('which', [bin])
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += String(chunk)
    })
    child.on('close', (code) => resolve(code === 0 ? out.trim() : null))
    child.on('error', () => resolve(null))
  })
}

function run(cmd: string, argv: string[]) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
}

async function fileStat(p: string) {
  try {
    return await stat(p)
  } catch {
    return null
  }
}

async function remoteSize(url: string) {
  const probe = await fetch(url, { headers: { Range: 'bytes=0-0' }, redirect: 'follow' })
  const range = probe.headers.get('content-range')
  const match = range?.match(/\/(\d+)$/)
  if (match) return Number(match[1])
  const length = Number(probe.headers.get('content-length'))
  if (Number.isFinite(length) && length > 1) return length
  throw new Error('Could not determine remote file size')
}

async function downloadRange(url: string, start: number, end: number, handle: Awaited<ReturnType<typeof open>>, onBytes: (n: number) => void) {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, redirect: 'follow' })
  if (!res.ok && res.status !== 206) throw new Error(`Range ${start}-${end} failed: ${res.status}`)
  if (!res.body) throw new Error('empty body')
  const reader = res.body.getReader()
  let offset = start
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    await handle.write(value, 0, value.byteLength, offset)
    offset += value.byteLength
    onBytes(value.byteLength)
  }
  if (offset !== end + 1) throw new Error(`Range ${start}-${end} ended at ${offset - 1}`)
}

async function parallelFetch(url: string, file: string, size: number, connections: number) {
  const handle = await open(file, 'w')
  await handle.truncate(size)
  const partSize = Math.ceil(size / connections)
  const limitFn = pLimit(connections)
  let bytes = 0
  let lastBytes = 0
  let lastAt = Date.now()
  const timer = setInterval(() => {
    const now = Date.now()
    const mbps = (bytes - lastBytes) / 1e6 / Math.max((now - lastAt) / 1000, 0.001)
    console.log(`  ${((bytes / size) * 100).toFixed(1)}%  ${(bytes / 1e9).toFixed(2)} / ${(size / 1e9).toFixed(2)} GB  ${mbps.toFixed(1)} MB/s`)
    lastBytes = bytes
    lastAt = now
  }, 2000)
  try {
    await Promise.all(
      Array.from({ length: connections }, (_, i) => {
        const start = i * partSize
        if (start >= size) return Promise.resolve()
        const end = Math.min(start + partSize - 1, size - 1)
        return limitFn(() =>
          downloadRange(url, start, end, handle, (n) => {
            bytes += n
          }),
        )
      }),
    )
  } finally {
    clearInterval(timer)
    await handle.close()
  }
}

async function ensureGzip() {
  if (skipDownload) {
    const existing = await fileStat(GZ_PATH)
    if (!existing) throw new Error(`--skip-download but missing ${GZ_PATH}`)
    return GZ_PATH
  }

  const size = await remoteSize(DATASET_URL)
  const existing = await fileStat(GZ_PATH)
  if (!forceDownload && existing && existing.size === size) {
    console.log(`✓ gzip already local (${(existing.size / 1e9).toFixed(2)} GB)`)
    return GZ_PATH
  }
  if (existing && existing.size !== size) {
    console.log(`› replacing incomplete gzip (${(existing.size / 1e9).toFixed(2)} GB ≠ ${(size / 1e9).toFixed(2)} GB)`)
    await unlink(GZ_PATH)
  }

  console.log(`1/5 fetch ${DATASET_URL}`)
  const aria2c = await which('aria2c')
  if (aria2c) {
    console.log(`› aria2c ${CONNECTIONS} connections`)
    const code = await run(aria2c, ['-c', `-x${CONNECTIONS}`, `-s${CONNECTIONS}`, '-k2M', '--file-allocation=none', '--allow-overwrite=true', `--dir=${DATA_DIR}`, `--out=${path.basename(GZ_PATH)}`, DATASET_URL])
    if (code !== 0) throw new Error(`aria2c exited ${code}`)
  } else {
    console.log(`› parallel Range download (${CONNECTIONS} parts)`)
    try {
      await parallelFetch(DATASET_URL, GZ_PATH, size, CONNECTIONS)
    } catch (err) {
      console.warn(`› parallel download failed: ${err instanceof Error ? err.message : err}`)
      const code = await run('curl', ['-L', '--fail', '--retry', '5', '--http2', '-C', '-', '-o', GZ_PATH, DATASET_URL])
      if (code !== 0) throw new Error(`curl exited ${code}`)
    }
  }

  const saved = await stat(GZ_PATH)
  console.log(`✓ gzip ${(saved.size / 1e9).toFixed(2)} GB`)
  return GZ_PATH
}

async function ensureCsv() {
  if (skipUnzip) {
    const csv = await fileStat(CSV_PATH)
    if (!csv) throw new Error(`--skip-unzip but missing ${CSV_PATH}`)
    return CSV_PATH
  }

  const gz = await stat(GZ_PATH)
  const csv = await fileStat(CSV_PATH)
  if (csv && csv.size > gz.size && csv.mtimeMs >= gz.mtimeMs) {
    console.log(`✓ csv already local (${(csv.size / 1e9).toFixed(2)} GB)`)
    return CSV_PATH
  }

  console.log('2/5 unzip (uncompressed CSV is often 15-25 GB)')
  const code = await run('gunzip', ['-k', '-f', GZ_PATH])
  if (code !== 0) throw new Error(`gunzip exited ${code}`)
  const out = await stat(CSV_PATH)
  console.log(`✓ csv ${(out.size / 1e9).toFixed(2)} GB`)
  return CSV_PATH
}

function csvField(value: string | null): string {
  if (value === null) return ''
  return `"${value.replace(/"/g, '""')}"`
}

function stripNul(value: string | null | undefined): string | null {
  if (value == null || value === '') return value === '' ? '' : null
  return value.replace(/\u0000/g, '')
}

function toBool(raw: string | undefined): string {
  if (!raw) return 'f'
  const v = raw.toLowerCase()
  return v === '1' || v === 'true' || v === 't' ? 't' : 'f'
}

function toPgArray(raw: string | undefined): string {
  const cleaned = stripNul(raw) ?? ''
  if (!cleaned || cleaned === '[]' || cleaned === '{}' || cleaned === 'null' || cleaned === '\\N') return '{}'
  const inner = cleaned.trim().replace(/^\[/, '').replace(/\]$/, '').replace(/^\{/, '').replace(/\}$/, '')
  if (!inner) return '{}'
  const nums = inner
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && part !== 'null' && Number.isFinite(Number(part)))
  return `{${nums.join(',')}}`
}

function toTimestamp(raw: string | undefined): string | null {
  const cleaned = stripNul(raw)
  if (!cleaned || cleaned === '\\N') return null
  const asNum = Number(cleaned)
  if (Number.isFinite(asNum) && asNum > 0) {
    if (asNum > 1_000_000_000_000) return new Date(asNum).toISOString()
    if (asNum > 1_000_000_000) return new Date(asNum * 1000).toISOString()
  }
  const normalized = cleaned.includes('T') || /[zZ]|[+-]\d\d/.test(cleaned) ? cleaned : `${cleaned.replace(' ', 'T')}Z`
  const parsed = new Date(normalized)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString()
}

function toInt(raw: string | undefined, treatZeroAsNull = false): string | null {
  const cleaned = stripNul(raw)
  if (cleaned === undefined || cleaned === null || cleaned === '' || cleaned === 'null' || cleaned === '\\N') return null
  const n = Number(cleaned)
  if (!Number.isFinite(n)) return null
  const truncated = Math.trunc(n)
  if (treatZeroAsNull && truncated === 0) return null
  return String(truncated)
}

function recordToCsv(record: Record<string, string>): string | null {
  const type = (stripNul(record.type) || '').toLowerCase()
  if (!ALLOWED_TYPES.has(type)) return null
  const id = toInt(record.id)
  if (!id) return null
  return (
    [
      csvField(id),
      csvField(toBool(record.deleted)),
      csvField(type),
      csvField(stripNul(record.by)),
      csvField(toTimestamp(record.time)),
      csvField(stripNul(record.text)),
      csvField(toBool(record.dead)),
      csvField(toInt(record.parent, true)),
      csvField(toInt(record.poll, true)),
      csvField(toPgArray(record.kids)),
      csvField(stripNul(record.url)),
      csvField(toInt(record.score)),
      csvField(stripNul(record.title)),
      csvField(toPgArray(record.parts)),
      csvField(toInt(record.descendants)),
    ].join(',') + '\n'
  )
}

function connect(url: string) {
  const client = new Client({
    connectionString: url,
    statement_timeout: 0,
    query_timeout: 0,
    keepAlive: true,
  })
  client.setMaxListeners(50)
  return client
}

async function csvHeader(file: string) {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8', end: 1_000_000 }), crlfDelay: Infinity })
  try {
    const line = await new Promise<string>((resolve, reject) => {
      rl.once('line', resolve)
      rl.once('error', reject)
      rl.once('close', () => reject(new Error('CSV is empty')))
    })
    const [header] = parseSync(line, { relax_quotes: true, relax_column_count: true })
    if (!header?.includes('id') || !header.includes('type')) throw new Error(`Unexpected CSV header: ${line.slice(0, 200)}`)
    return header
  } finally {
    rl.close()
  }
}

async function newlineAtOrAfter(file: string, at: number, fileSize: number) {
  if (at <= 0) return 0
  if (at >= fileSize) return fileSize
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(64 * 1024)
    let pos = at
    while (pos < fileSize) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, fileSize - pos), pos)
      if (bytesRead === 0) break
      const idx = buf.subarray(0, bytesRead).indexOf(10)
      if (idx !== -1) return pos + idx + 1
      pos += bytesRead
    }
    return fileSize
  } finally {
    await fh.close()
  }
}

async function splitRanges(file: string, fileSize: number, streams: number): Promise<RangeState[]> {
  const n = Math.max(1, Math.min(streams, fileSize > 1 ? streams : 1))
  const raw = Math.ceil(fileSize / n)
  const starts: number[] = [0]
  for (let i = 1; i < n; i++) {
    starts.push(await newlineAtOrAfter(file, i * raw, fileSize))
  }
  starts.push(fileSize)
  const unique = [...new Set(starts)].sort((a, b) => a - b)
  const ranges: RangeState[] = []
  for (let i = 0; i < unique.length - 1; i++) {
    if (unique[i] < unique[i + 1]) ranges.push({ start: unique[i], end: unique[i + 1], processed: 0, inserted: 0 })
  }
  return ranges
}

let checkpointWrite: Promise<void> = Promise.resolve()

function saveCheckpoint(state: Checkpoint) {
  const body = JSON.stringify(state)
  checkpointWrite = checkpointWrite.then(() => writeFile(CHECKPOINT, body))
  return checkpointWrite
}

function drain(stream: NodeJS.WritableStream) {
  return new Promise<void>((resolve) => {
    stream.once('drain', resolve)
  })
}

async function copyLines(client: Client, lines: string[]) {
  if (!lines.length) return
  const copyStream = client.query(copyFrom(`COPY items (${COLUMNS.join(', ')}) FROM STDIN WITH (FORMAT csv, NULL '')`))
  const done = finished(copyStream)
  for (const line of lines) {
    if (!copyStream.write(line)) await drain(copyStream)
  }
  copyStream.end()
  await done
}

async function copyBatch(client: Client, lines: string[]) {
  try {
    await copyLines(client, lines)
    return lines.length
  } catch (err) {
    console.warn(`  batch of ${lines.length} failed (${err instanceof Error ? err.message : err}), retrying row-by-row`)
    let ok = 0
    for (const line of lines) {
      try {
        await copyLines(client, [line])
        ok += 1
      } catch (rowErr) {
        console.warn(`  skipped row: ${rowErr instanceof Error ? rowErr.message : rowErr}`)
      }
    }
    return ok
  }
}

async function createSchema(client: Client) {
  await client.query(CREATE_SQL)
}

async function copyRange(opts: { url: string; csvPath: string; header: string[]; range: RangeState; skipHeader: boolean; skipRows: number; maxRows: number; onProgress: (range: RangeState) => Promise<void> }) {
  const client = connect(opts.url)
  await client.connect()
  try {
    const parser = parse({
      columns: opts.header,
      relax_quotes: true,
      relax_column_count: true,
      skip_empty_lines: true,
      bom: opts.skipHeader,
      from_line: opts.skipHeader ? 2 : 1,
    })
    createReadStream(opts.csvPath, { start: opts.range.start, end: opts.range.end - 1 }).pipe(parser)

    let batch: string[] = []
    let processed = 0
    let inserted = 0
    for await (const record of parser) {
      processed += 1
      if (processed <= opts.skipRows) continue
      if (processed > opts.maxRows) break
      const line = recordToCsv(record as Record<string, string>)
      if (line) batch.push(line)
      if (batch.length >= BATCH) {
        inserted += await copyBatch(client, batch)
        batch = []
        opts.range.processed = processed
        opts.range.inserted = inserted
        await opts.onProgress(opts.range)
      }
    }
    if (batch.length) {
      inserted += await copyBatch(client, batch)
    }
    opts.range.processed = processed
    opts.range.inserted = inserted
    await opts.onProgress(opts.range)
  } finally {
    await client.end()
  }
}

async function finalize(client: Client) {
  await client.query(`SET statement_timeout = 0`)
  try {
    await client.query(`SET maintenance_work_mem = '2GB'`)
  } catch {
    // Neon may cap this
  }

  console.log('4/5 primary key + generated search_tsv')
  await client.query('ALTER TABLE items ADD PRIMARY KEY (id)')
  await client.query(`ALTER TABLE items ADD CONSTRAINT items_type_check CHECK (type IN ('story', 'comment', 'poll', 'pollopt', 'job'))`)
  await client.query(`ALTER TABLE items ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (${SEARCH_TSV_SQL}) STORED`)

  console.log('5/5 btree / trigram indexes')
  await client.query(INDEX_SQL)
  if (withBm25) {
    console.log('› BM25 indexes (--bm25): full corpus + per-type partials')
    await client.query(BM25_SQL)
  }
  // VACUUM (outside a transaction) refreshes the planner and BM25 corpus stats.
  await client.query('VACUUM ANALYZE items')
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true })
  await ensureGzip()
  const csvPath = await ensureCsv()
  const fileSize = (await stat(csvPath)).size
  const url = unpooledUrl()
  const streams = limit > 0 ? 1 : requestedStreams
  const ranges = await splitRanges(csvPath, fileSize, streams)
  const checkpoint: Checkpoint = { version: 2, streams: ranges.length, fileSize, ranges, phase: 'copy' }
  await saveCheckpoint(checkpoint)

  const admin = connect(url)
  await admin.connect()
  try {
    console.log(`3/5 create heap table on ${describeUrl(url)}: ${ranges.length} COPY streams, batch ${BATCH}`)
    await createSchema(admin)

    const header = await csvHeader(csvPath)
    const started = Date.now()
    const timer = setInterval(() => {
      const processed = checkpoint.ranges.reduce((n, r) => n + r.processed, 0)
      const inserted = checkpoint.ranges.reduce((n, r) => n + r.inserted, 0)
      const secs = Math.max((Date.now() - started) / 1000, 1)
      console.log(`  …${inserted.toLocaleString()} inserted / ${processed.toLocaleString()} read (${(inserted / secs).toFixed(0)} rows/s)`)
    }, 5000)

    try {
      await Promise.all(
        checkpoint.ranges.map((range, index) =>
          copyRange({
            url,
            csvPath,
            header,
            range,
            skipHeader: range.start === 0,
            skipRows: 0,
            maxRows: limit > 0 ? limit : Number.POSITIVE_INFINITY,
            onProgress: async () => {
              await saveCheckpoint(checkpoint)
            },
          }).then(() => {
            console.log(`  stream ${index + 1}/${checkpoint.ranges.length} done (${range.inserted.toLocaleString()} inserted)`)
          }),
        ),
      )
    } finally {
      clearInterval(timer)
    }

    const [{ count }] = (await admin.query('SELECT count(*)::text AS count FROM items')).rows as Array<{ count: string }>
    console.log(`✓ ${Number(count).toLocaleString()} rows in items`)
    if (Number(count) === 0) throw new Error('items is still empty')
    checkpoint.phase = 'generated'
    await saveCheckpoint(checkpoint)

    await finalize(admin)
    checkpoint.phase = 'done'
    checkpoint.done = true
    await saveCheckpoint(checkpoint)
    console.log('✓ seed complete')
  } finally {
    await admin.end()
    await checkpointWrite
  }
}

main().catch((err) => {
  console.error('✗ Seed failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
