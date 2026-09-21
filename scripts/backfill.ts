/**
 * Two-phase, resumable backfill of the 2021-to-now gap from the HN Firebase API.
 *
 * Fetch and load are separated so a crash never throws away downloaded data:
 *
 *   1. FETCH  downloads the whole id range to local gzipped, COPY-ready CSV
 *      shards under data/backfill/. Each shard covers a fixed id window and is
 *      marked done in a manifest only after it is fully written, so a resume
 *      re-fetches at most one shard. The HN API sustains ~1000 items/s, so this
 *      phase is network-bound and independent of the database.
 *
 *   2. LOAD streams those shards into Postgres. Both modes COPY each shard into
 *      an unlogged, index-free staging table then INSERT ... ON CONFLICT DO
 *      NOTHING into `items`, run across parallel workers, so a resume (or an id
 *      the seed already inserted) can never duplicate a row. They differ
 *      only in what indexes exist during the load:
 *        --mode=online  (default) leaves every index live, so search keeps
 *          working, but each row pays BM25 + GIN index maintenance.
 *        --mode=rebuild drops all 12 secondary indexes first (keeping only the
 *          primary key) and recreates them once at the end. Far faster for a
 *          large one-shot load, but search is degraded until the rebuild
 *          finishes, so run it in a maintenance window.
 *
 * Batch size alone does not fix throughput: index maintenance is a per-row cost,
 * so a bigger COPY only saves round-trip overhead. Dropping and rebuilding the
 * indexes (rebuild mode) is what turns a ~13h load into a couple of hours.
 *
 *   npm run db:backfill -- --phase=fetch
 *   npm run db:backfill -- --phase=load --mode=rebuild --workers=6
 *   npm run db:backfill -- --phase=all                    # fetch then online load
 *   npm run db:backfill -- --phase=fetch --from=28738665 --to=30000000
 *
 * Ideal setup: run it on a small box in the DB's region (us-east-2) and raise the
 * Neon compute's autoscaling ceiling for the duration, since load throughput is
 * CPU-bound on the database, not on this machine.
 */

import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { finished, pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import pLimit from 'p-limit'
import { Client } from 'pg'
import { from as copyFrom } from 'pg-copy-streams'
import { describeUrl, unpooledUrl } from './env'

const HN_API = 'https://hacker-news.firebaseio.com/v0'
const ALLOWED = new Set(['story', 'comment', 'poll', 'pollopt', 'job'])
const DIR = path.join(process.cwd(), 'data', 'backfill')
const MANIFEST = path.join(DIR, 'manifest.json')

const COLS = ['id', 'deleted', 'type', '"by"', 'time', 'text', 'dead', 'parent', 'poll', 'kids', 'url', 'score', 'title', 'parts', 'descendants']

// Every secondary index. In rebuild mode all of these are dropped before the
// load and recreated once at the end, so COPY/INSERT only maintains the primary
// key. The list and the DDL mirror scripts/seed.ts and src/db/schema.ts. The
// PRIMARY KEY on id is deliberately kept: it is an append-only btree for the
// ascending backfill ids, so its cost is negligible, and it keeps the load
// idempotent (ON CONFLICT) against ids the seed may have already inserted.
const SECONDARY_INDEXES = [
  'items_type_time_idx',
  'items_type_score_idx',
  'items_parent_idx',
  'items_by_time_idx',
  'items_title_trgm_idx',
  'items_by_trgm_idx',
  'items_story_new_idx',
  'items_titled_time_idx',
  'items_search_gin',
  'items_search_bm25',
  'items_story_bm25',
  'items_comment_bm25',
  'items_job_bm25',
]
const RECREATE_SQL = `
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
CREATE INDEX IF NOT EXISTS items_search_gin ON items USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS items_search_bm25 ON items USING lakebase_bm25 (search_tsv);
CREATE INDEX IF NOT EXISTS items_story_bm25 ON items USING lakebase_bm25 (search_tsv)
  WHERE type = 'story' AND NOT deleted AND NOT dead;
CREATE INDEX IF NOT EXISTS items_comment_bm25 ON items USING lakebase_bm25 (search_tsv)
  WHERE type = 'comment' AND NOT deleted AND NOT dead;
CREATE INDEX IF NOT EXISTS items_job_bm25 ON items USING lakebase_bm25 (search_tsv)
  WHERE type = 'job' AND NOT deleted AND NOT dead;
`

const args = process.argv.slice(2)
const argStr = (name: string, fallback: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const argNum = (name: string, fallback: number) => Number(argStr(name, String(fallback)))
const PHASE = argStr('phase', 'all') as 'fetch' | 'load' | 'all'
const MODE = argStr('mode', 'online') as 'online' | 'rebuild'
const CONCURRENCY = Math.max(1, Math.min(800, argNum('concurrency', 480)))
const WORKERS = Math.max(1, Math.min(16, argNum('workers', 6)))
const WINDOW = Math.max(500, argNum('window', 4000))
const SHARD_IDS = Math.max(WINDOW, argNum('shard', 100000))
const FROM = argNum('from', 0)
const TO = argNum('to', 0)

type Shard = { start: number; end: number; rows: number; fetched: boolean; loaded: boolean }
type Manifest = { start: number; end: number; shardIds: number; shards: Record<string, Shard> }

type HnItem = {
  id: number
  deleted?: boolean
  type?: string
  by?: string
  time?: number
  text?: string
  dead?: boolean
  parent?: number
  poll?: number
  kids?: number[]
  url?: string
  score?: number
  title?: string
  parts?: number[]
  descendants?: number
}

async function fetchJson<T>(url: string, timeoutMs = 8000): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, { signal: controller.signal, cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as T
    } catch {
      if (attempt === 2) return null
    } finally {
      clearTimeout(timer)
    }
  }
  return null
}

const NUL = String.fromCharCode(0)
function csvField(value: string | null): string {
  if (value === null) return ''
  return `"${value.split(NUL).join('').replace(/"/g, '""')}"`
}

function pgArray(values: number[] | undefined): string {
  if (!values?.length) return '{}'
  return `{${values.filter((n) => Number.isFinite(n)).join(',')}}`
}

function toLine(raw: HnItem | null): string | null {
  if (!raw || !Number.isFinite(raw.id) || !raw.type || !ALLOWED.has(raw.type)) return null
  return (
    [
      csvField(String(raw.id)),
      csvField(raw.deleted ? 't' : 'f'),
      csvField(raw.type),
      csvField(raw.by ?? null),
      csvField(typeof raw.time === 'number' ? new Date(raw.time * 1000).toISOString() : null),
      csvField(raw.text ?? null),
      csvField(raw.dead ? 't' : 'f'),
      csvField(Number.isFinite(raw.parent) ? String(raw.parent) : null),
      csvField(Number.isFinite(raw.poll) ? String(raw.poll) : null),
      csvField(pgArray(raw.kids)),
      csvField(raw.url ?? null),
      csvField(Number.isFinite(raw.score) ? String(raw.score) : null),
      csvField(raw.title ?? null),
      csvField(pgArray(raw.parts)),
      csvField(Number.isFinite(raw.descendants) ? String(raw.descendants) : null),
    ].join(',') + '\n'
  )
}

function connect(url: string) {
  const client = new Client({ connectionString: url, statement_timeout: 0, query_timeout: 0, keepAlive: true })
  client.setMaxListeners(50)
  return client
}

const shardPath = (s: Shard) => path.join(DIR, `${s.start}-${s.end}.csv.gz`)
const shardKey = (start: number) => String(start)

let manifestWrite: Promise<void> = Promise.resolve()
function saveManifest(m: Manifest) {
  const body = JSON.stringify(m)
  manifestWrite = manifestWrite.then(() => writeFile(MANIFEST, body))
  return manifestWrite
}

async function loadManifest(): Promise<Manifest | null> {
  try {
    return JSON.parse(await readFile(MANIFEST, 'utf8')) as Manifest
  } catch {
    return null
  }
}

/** Build (or extend) the manifest so it covers [start, end] in SHARD_IDS windows. */
function planShards(existing: Manifest | null, start: number, end: number): Manifest {
  const m: Manifest = existing ?? { start, end, shardIds: SHARD_IDS, shards: {} }
  m.start = Math.min(m.start, start)
  m.end = Math.max(m.end, end)
  for (let s = start; s <= end; s += m.shardIds) {
    const key = shardKey(s)
    if (!m.shards[key]) m.shards[key] = { start: s, end: Math.min(s + m.shardIds - 1, end), rows: 0, fetched: false, loaded: false }
  }
  return m
}

const limit = pLimit(CONCURRENCY)

/** Fetch one shard to a temp gz file, then atomically rename it into place. */
async function fetchShard(shard: Shard): Promise<number> {
  const tmp = shardPath(shard) + '.tmp'
  const gzip = createGzip()
  const out = createWriteStream(tmp)
  gzip.pipe(out)
  const write = (line: string) =>
    new Promise<void>((resolve) => {
      if (gzip.write(line)) resolve()
      else gzip.once('drain', resolve)
    })

  let rows = 0
  for (let w = shard.start; w <= shard.end; w += WINDOW) {
    const ids: number[] = []
    for (let id = w; id <= Math.min(w + WINDOW - 1, shard.end); id++) ids.push(id)
    const items = await Promise.all(ids.map((id) => limit(() => fetchJson<HnItem>(`${HN_API}/item/${id}.json`))))
    for (const item of items) {
      const line = toLine(item)
      if (line) {
        await write(line)
        rows++
      }
    }
  }
  gzip.end()
  await finished(out)
  await rename(tmp, shardPath(shard))
  return rows
}

async function runFetch(start: number, end: number) {
  const maxItem = await fetchJson<number>(`${HN_API}/maxitem.json`)
  if (!maxItem) throw new Error('Could not read HN maxitem')
  const rangeEnd = end || maxItem

  let manifest = planShards(await loadManifest(), start, rangeEnd)
  await saveManifest(manifest)
  const pending = Object.values(manifest.shards).filter((s) => !s.fetched && s.start >= start && s.end <= rangeEnd)
  console.log(`› FETCH ${start.toLocaleString()} → ${rangeEnd.toLocaleString()}: ${pending.length} shards of ${manifest.shardIds.toLocaleString()} ids left`)

  const runStart = Date.now()
  let doneRows = 0
  for (const shard of pending.sort((a, b) => a.start - b.start)) {
    const rows = await fetchShard(shard)
    shard.rows = rows
    shard.fetched = true
    await saveManifest(manifest)
    doneRows += rows
    const secs = Math.max((Date.now() - runStart) / 1000, 0.001)
    const idsDone = shard.end - pending[0].start + 1
    const rate = idsDone / secs
    const remaining = rangeEnd - shard.end
    console.log(`  shard ${shard.start.toLocaleString()}-${shard.end.toLocaleString()}: ${rows.toLocaleString()} rows  (${rate.toFixed(0)} ids/s, ETA ${(remaining / Math.max(rate, 1) / 3600).toFixed(1)}h)`)
  }
  console.log(`✓ fetch complete: ${doneRows.toLocaleString()} rows on disk in ${DIR}`)
}

/** COPY one shard's gz stream into `target`, returning rows copied. */
async function copyShardInto(client: Client, shard: Shard, target: string): Promise<number> {
  const copy = client.query(copyFrom(`COPY ${target} (${COLS.join(', ')}) FROM STDIN WITH (FORMAT csv, NULL '')`))
  await pipeline(createReadStream(shardPath(shard)), createGunzip(), copy)
  return shard.rows
}

async function runLoad(url: string) {
  const manifest = await loadManifest()
  if (!manifest) throw new Error('No manifest found, run --phase=fetch first')
  const todo = Object.values(manifest.shards)
    .filter((s) => s.fetched && !s.loaded)
    .sort((a, b) => a.start - b.start)
  if (!todo.length) {
    console.log('✓ nothing to load (all fetched shards already loaded)')
    return
  }
  console.log(`› LOAD ${MODE}: ${todo.length} shards, ${WORKERS} workers`)

  const runStart = Date.now()
  let loadedRows = 0
  const report = (shard: Shard) => {
    loadedRows += shard.rows
    const secs = Math.max((Date.now() - runStart) / 1000, 0.001)
    console.log(`  loaded ${shard.start.toLocaleString()}-${shard.end.toLocaleString()} (+${shard.rows.toLocaleString()}, ${(loadedRows / secs).toFixed(0)} rows/s)`)
  }

  if (MODE === 'rebuild') {
    const admin = connect(url)
    await admin.connect()
    console.log(`› dropping ${SECONDARY_INDEXES.length} secondary indexes (search is degraded until the rebuild finishes)`)
    for (const idx of SECONDARY_INDEXES) await admin.query(`DROP INDEX IF EXISTS ${idx}`)
    await admin.end()
  }

  // Shared queue of shards, drained by the worker pool.
  let cursor = 0
  const nextShard = () => (cursor < todo.length ? todo[cursor++] : null)

  // Both modes load through an unlogged, index-free staging table, then
  // INSERT ... ON CONFLICT DO NOTHING into items. That keeps the fast COPY apart
  // from the constraint-checking insert and makes every shard idempotent, so a
  // resume (or an id the seed already inserted) can never duplicate a row. In
  // rebuild mode the insert only maintains the primary key, since the secondary
  // indexes were dropped above.
  await Promise.all(
    Array.from({ length: WORKERS }, async (_, i) => {
      const client = connect(url)
      await client.connect()
      const stg = `items_backfill_stg_${i}`
      try {
        await client.query(`CREATE UNLOGGED TABLE IF NOT EXISTS ${stg} (LIKE items INCLUDING DEFAULTS EXCLUDING CONSTRAINTS EXCLUDING INDEXES)`)
        await client.query(`ALTER TABLE ${stg} DROP COLUMN IF EXISTS search_tsv`)
        for (let shard = nextShard(); shard; shard = nextShard()) {
          // Per-shard transaction: a crash rolls the shard back, and it is marked
          // loaded only after commit, so a resume re-COPYs it cleanly.
          await client.query('BEGIN')
          await client.query(`TRUNCATE ${stg}`)
          await copyShardInto(client, shard, stg)
          await client.query(`INSERT INTO items (${COLS.join(', ')}) SELECT ${COLS.join(', ')} FROM ${stg} ON CONFLICT (id) DO NOTHING`)
          await client.query('COMMIT')
          shard.loaded = true
          await saveManifest(manifest)
          report(shard)
        }
      } finally {
        await client.query(`DROP TABLE IF EXISTS ${stg}`).catch(() => {})
        await client.end()
      }
    }),
  )

  const post = connect(url)
  await post.connect()
  try {
    if (MODE === 'rebuild') {
      // Give the index builds room and parallel workers. Neon caps these to the
      // compute size, so setting them high just uses whatever CU is available.
      for (const stmt of [`SET maintenance_work_mem = '8GB'`, `SET max_parallel_maintenance_workers = 16`]) {
        try {
          await post.query(stmt)
        } catch {
          // Neon may cap or reject, the build still runs, just slower.
        }
      }
      console.log('› recreating 12 secondary indexes (the slow part, BM25 + GIN dominate)')
      await post.query(RECREATE_SQL)
    }
    console.log('› ANALYZE items')
    await post.query('ANALYZE items')
  } finally {
    await post.end()
  }
  const secs = (Date.now() - runStart) / 1000
  console.log(`✓ load complete: ${loadedRows.toLocaleString()} rows in ${(secs / 3600).toFixed(2)}h (${(loadedRows / secs).toFixed(0)} rows/s)`)
}

async function main() {
  await mkdir(DIR, { recursive: true })
  const url = unpooledUrl()
  console.log(`› ${describeUrl(url)}`)

  if (PHASE === 'fetch' || PHASE === 'all') {
    let start = FROM
    if (!start) {
      const existing = await loadManifest()
      if (existing) start = existing.start
      else {
        const admin = connect(url)
        await admin.connect()
        start = Number((await admin.query('SELECT COALESCE(MAX(id), 0)::text AS m FROM items')).rows[0].m) + 1
        await admin.end()
      }
    }
    await runFetch(start, TO)
  }

  if (PHASE === 'load' || PHASE === 'all') {
    await runLoad(url)
  }

  await manifestWrite
}

main().catch((err) => {
  console.error('✗ backfill failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
