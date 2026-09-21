import { sql, timed } from '@/db'
import { ITEM_TYPES, type ItemType, type ThreadVerdict } from '@/db/schema'
import { COUNT_CAP, MAX_CANDIDATES, PAGE_SIZE, sinceCutoff, type SearchFilters } from '@/lib/search-params'

/**
 * Each item type has its own partial `lakebase_bm25` index whose predicate
 * matches the `WHERE` below. Ranking and counting therefore happen over the
 * requested type only. The single shared index would rank all five types
 * together and, because it scores just its top `default_limit` candidates,
 * silently drop most stories/jobs before the type filter ran.
 */
const PARTIAL_BM25: Partial<Record<ItemType, string>> = {
  story: 'items_story_bm25',
  comment: 'items_comment_bm25',
  job: 'items_job_bm25',
}
/** Covers `all` and the long-tail types (poll, pollopt) that have no partial index. */
const FULL_BM25 = 'items_search_bm25'

export type ItemRecord = {
  id: number
  type: string
  by: string | null
  time: string | null
  url: string | null
  score: number | null
  title: string | null
  descendants: number | null
  parent: number | null
}

export type SearchHit = ItemRecord & { snippet: string | null }

/** A home-page browse row: a thread hit, carrying its Jev verdict when it has one. */
export type HomeThread = SearchHit & { verdict: ThreadVerdict | null }

/** Per-comment Jev judgment, present only on scored items (see judge-threads.ts). */
export type JevFields = {
  jevStance: 'support' | 'critical' | 'neutral' | null
  jevSubstance: number | null
  jevSpice: number | null
  jevIsQuestion: boolean | null
}
export type ThreadItem = ItemRecord & { text: string | null; deleted: boolean; dead: boolean; jevVerdict: ThreadVerdict | null } & JevFields

export type MatchCount = { count: number | null; capped: boolean; estimate: number | null; ms: number }

type Row = Record<string, unknown>

function push(values: unknown[], value: unknown): string {
  values.push(value)
  return `$${values.length}`
}

function asInt(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function asHit(row: Row): SearchHit {
  return {
    id: asInt(row.id) ?? 0,
    type: String(row.type ?? ''),
    by: (row.by as string | null) ?? null,
    time: (row.time as string | null) ?? null,
    url: (row.url as string | null) ?? null,
    score: asInt(row.score),
    title: (row.title as string | null) ?? null,
    descendants: asInt(row.descendants),
    parent: asInt(row.parent),
    snippet: (row.snippet as string | null) ?? null,
  }
}

/** A hit plus its thread-level Jev verdict (null on comments and unscored stories). */
function asHomeThread(row: Row): HomeThread {
  return { ...asHit(row), verdict: (row.jev_verdict as ThreadVerdict | null) ?? null }
}

function asReal(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function asThread(row: Row): ThreadItem {
  return {
    ...asHit(row),
    text: (row.text as string | null) ?? null,
    deleted: Boolean(row.deleted),
    dead: Boolean(row.dead),
    jevStance: (row.jev_stance as ThreadItem['jevStance']) ?? null,
    jevSubstance: asReal(row.jev_substance),
    jevSpice: asReal(row.jev_spice),
    jevIsQuestion: row.jev_is_question == null ? null : Boolean(row.jev_is_question),
    jevVerdict: (row.jev_verdict as ThreadVerdict | null) ?? null,
  }
}

function hitColumns(withSnippet: boolean): string {
  const snippet = withSnippet ? `left(regexp_replace(coalesce(text, ''), '<[^>]+>', ' ', 'g'), 240) AS snippet` : `NULL::text AS snippet`
  return `id, type, "by", time, url, score, title, descendants, parent, ${snippet}`
}

const THREAD_COLUMNS = `id, type, "by", time, url, score, title, text, descendants, parent, deleted, dead, jev_stance, jev_substance, jev_spice, jev_is_question, jev_verdict`

type Filter = {
  where: string
  values: unknown[]
  q: string
  /** Non-null when the query is full-text: the BM25 index that ranks this type. */
  bm25Index: string | null
  /** `by`/`since` are not baked into the partial indexes, so they need extra scoring headroom. */
  hasResidualFilter: boolean
}

function buildFilter(filters: SearchFilters): Filter {
  const values: unknown[] = []
  const clauses = ['NOT deleted', 'NOT dead']
  const q = filters.q ?? ''
  const type = filters.type

  // A validated literal (never user text) so the planner can match the partial index predicate.
  if (type !== 'all' && (ITEM_TYPES as readonly string[]).includes(type)) {
    clauses.push(`type = '${type}'`)
  }
  if (filters.by) clauses.push(`"by" = ${push(values, filters.by)}`)
  const cutoff = sinceCutoff(filters.since)
  if (cutoff) clauses.push(`time >= ${push(values, cutoff.toISOString())}::timestamptz`)

  let bm25Index: string | null = null
  if (q.length > 0 && q.length <= 2) {
    const prefix = `${q}%`
    clauses.push(`(title ILIKE ${push(values, prefix)} OR "by" ILIKE ${push(values, prefix)})`)
  } else if (q.length > 2) {
    // websearch syntax supports "quoted phrases", -negation and OR from the box.
    clauses.push(`search_tsv @@ websearch_to_tsquery('english', ${push(values, q)})`)
    bm25Index = (type !== 'all' && PARTIAL_BM25[type as ItemType]) || FULL_BM25
  } else if (type !== 'comment') {
    clauses.push(`title IS NOT NULL AND title <> ''`)
  }

  return { where: `WHERE ${clauses.join(' AND ')}`, values, q, bm25Index, hasResidualFilter: Boolean(filters.by) || Boolean(cutoff) }
}

/** BM25 relevance ordering. Pushes the query text used to build the query vector. */
function bm25Order(q: string, index: string, values: unknown[]): string {
  return `search_tsv <@> to_bm25query(to_tsvector('english', ${push(values, q)}), '${index}')`
}

/** Chronological / points / comment-count ordering (time DESC is NULLS FIRST). */
function plainOrder(sort: SearchFilters['sort']): string {
  if (sort === 'comments') return 'descendants DESC NULLS LAST, time DESC'
  if (sort === 'score') return 'score DESC NULLS LAST, time DESC'
  return 'time DESC'
}

/**
 * How many candidates the BM25 index should score. It must cover the page being
 * read (`offset + PAGE_SIZE`). When residual `by`/`since` filters run after the
 * index it is opened to the cap so enough survivors remain.
 */
function candidateLimit(offset: number, hasResidualFilter: boolean): number {
  if (hasResidualFilter) return MAX_CANDIDATES
  return Math.min(MAX_CANDIDATES, offset + PAGE_SIZE + 30)
}

/**
 * Runs `text`. When a BM25 limit is supplied it wraps the statement in a
 * transaction that first sets `lakebase_bm25.default_limit`. SET cannot be
 * parameterized, so `limit` is interpolated (always a computed integer).
 */
async function run(limit: number | null, text: string, values: unknown[]): Promise<Row[]> {
  if (limit == null) return (await sql.query(text, values)) as Row[]
  const result = (await sql.transaction([sql.query(`SET LOCAL lakebase_bm25.default_limit = ${limit | 0}`), sql.query(text, values)])) as unknown[]
  return result[1] as Row[]
}

/**
 * For the comments sort we take this many of the most relevant matches off the
 * fast BM25 index and then order that pool by comment count. Big enough that the
 * genuinely most-discussed matches are in it, small enough to stay well under
 * ~150ms even for the broadest single-word queries.
 */
const SEARCH_POOL = 500

export async function searchItems(filters: SearchFilters, page: number) {
  const offset = (page - 1) * PAGE_SIZE
  const { where, values, q, bm25Index, hasResidualFilter } = buildFilter(filters)
  // Carry jev_verdict so a scored story shows the same verdict strip in search as on the
  // home page. It is null on comments and unscored stories, so the row just renders plain.
  const cols = `${hitColumns(filters.type === 'comment' || filters.type === 'pollopt' || (filters.type === 'all' && Boolean(filters.q)))}, jev_verdict`
  // Search results come back most-discussed first (decreasing comment count).
  const sort = filters.sort ?? (q ? 'comments' : 'date')

  // Default text search: pull a pool of the most relevant matches straight off the
  // fast BM25 ordered index, then sort that pool by comment count. Ordering all
  // matches in SQL is a multi-second heapsort on broad terms. This stays snappy and
  // still surfaces the most-discussed threads, which rank highly on relevance anyway.
  if (bm25Index && sort === 'comments') {
    const pool = `SELECT ${cols} FROM items ${where} ORDER BY ${bm25Order(q, bm25Index, values)} LIMIT ${SEARCH_POOL}`
    const { rows, ms } = await timed(() => run(SEARCH_POOL, pool, values))
    const ranked = rows.map(asHomeThread).sort((a, b) => (b.descendants ?? -1) - (a.descendants ?? -1) || String(b.time ?? '').localeCompare(String(a.time ?? '')))
    return { rows: ranked.slice(offset, offset + PAGE_SIZE), ms, page }
  }

  let text: string
  let limit: number | null = null

  if (bm25Index && sort === 'relevance') {
    // Page straight off the ranked stream. Only score enough to reach this page.
    const order = bm25Order(q, bm25Index, values)
    limit = candidateLimit(offset, hasResidualFilter)
    text = `SELECT ${cols} FROM items ${where} ORDER BY ${order} LIMIT ${push(values, PAGE_SIZE)} OFFSET ${push(values, offset)}`
  } else if (bm25Index) {
    // Date/points sort of a text query: an unranked filter is a seq scan, so pull
    // the BM25 matches (bounded by the cap) and re-sort them. Exact for any query
    // with at most COUNT_CAP matches, which covers all but the broadest terms.
    const order = bm25Order(q, bm25Index, values)
    limit = MAX_CANDIDATES
    text = `SELECT * FROM (SELECT ${cols} FROM items ${where} ORDER BY ${order} LIMIT ${MAX_CANDIDATES}) hits ORDER BY ${plainOrder(sort)} LIMIT ${push(values, PAGE_SIZE)} OFFSET ${push(values, offset)}`
  } else {
    // Browsing or a short prefix: a btree/partial index already provides the order.
    text = `SELECT ${cols} FROM items ${where} ORDER BY ${plainOrder(sort)} LIMIT ${push(values, PAGE_SIZE)} OFFSET ${push(values, offset)}`
  }

  const { rows, ms } = await timed(() => run(limit, text, values))
  return { rows: rows.map(asHomeThread), ms, page }
}

/** Exact counting is abandoned after this long. The estimate takes over. */
const COUNT_TIMEOUT_MS = 400

/** Reads `Plan Rows` out of an `EXPLAIN (FORMAT JSON)` result row. */
function planEstimate(rows: Row[]): number | null {
  const cell = rows[0]?.['QUERY PLAN']
  const plan = typeof cell === 'string' ? JSON.parse(cell) : cell
  const rowsEst = plan?.[0]?.Plan?.['Plan Rows']
  return typeof rowsEst === 'number' ? Math.round(rowsEst) : null
}

/**
 * Match count for the status line. The `items_search_gin` GIN index serves
 * `search_tsv @@ websearch_to_tsquery(...)` through a bitmap scan, so an exact
 * count is a plain `count(*)` over the filter, with no BM25 ordering, no default_limit,
 * and no seq scan. A multi-word query is a tsquery AND: GIN intersects the per-term
 * posting lists, so it is the cheapest case (e.g. "openbsd chrome" ~4ms), not the
 * pathological one it was against the BM25 ranking index. Only very common single
 * terms approach the cap. This still races two things in parallel:
 *
 *   1. an exact count, bounded by {@link COUNT_CAP} rows and a `statement_timeout`
 *      guard so it can never hang, and
 *   2. the planner's instant row estimate.
 *
 * When the exact count returns under the cap in time, it wins ("165 results").
 * Otherwise (capped, or too slow) the rounded estimate is shown ("~34,000
 * results"). Returns `count: null` for empty-query browsing.
 */
export async function countMatches(filters: SearchFilters): Promise<MatchCount> {
  const q = filters.q ?? ''
  if (q.length === 0) return { count: null, capped: false, estimate: null, ms: 0 }

  const { where, values } = buildFilter(filters)
  const countText = `SELECT count(*)::int AS n FROM (SELECT 1 FROM items ${where} LIMIT ${COUNT_CAP}) hits`

  const started = performance.now()
  const [estimate, exact] = await Promise.all([
    (async () => {
      try {
        const rows = (await sql.query(`EXPLAIN (FORMAT JSON) SELECT 1 FROM items ${where}`, values)) as Row[]
        return planEstimate(rows)
      } catch {
        return null
      }
    })(),
    (async () => {
      try {
        const res = (await sql.transaction([sql.query(`SET LOCAL statement_timeout = ${COUNT_TIMEOUT_MS | 0}`), sql.query(countText, values)])) as Row[][]
        return asInt(res[res.length - 1][0]?.n) ?? 0
      } catch {
        return null // statement_timeout (or any error): fall back to the estimate
      }
    })(),
  ])
  const ms = performance.now() - started

  const exactOk = exact != null && exact < COUNT_CAP
  return { count: exactOk ? exact : null, capped: !exactOk, estimate: exactOk ? null : estimate, ms }
}

/**
 * Approximate size of the corpus for the footer, read from the planner's cached
 * statistic (`pg_class.reltuples`) instead of a `count(*)`. Sub-millisecond and
 * needs no table scan, and it stays accurate to within an autovacuum cycle,
 * which is plenty for a headline number that grows every hour.
 */
export async function corpusSize(): Promise<number | null> {
  try {
    const rows = (await sql.query(`SELECT reltuples::bigint::text AS n FROM pg_class WHERE relname = 'items'`)) as Row[]
    const n = asInt(rows[0]?.n)
    return n != null && n > 0 ? n : null
  } catch {
    return null
  }
}

export type ThreadTopComment = ThreadItem & { hasReplies: boolean }
export type ThreadHead = { root: ThreadItem | null; topLevel: ThreadTopComment[]; ms: number }

/**
 * Phase 1 of the item page: the root item and its direct (top-level) comments,
 * in one round trip. Small and fast, so the shell paints before the deeper
 * replies stream in. `hasReplies` comes from each comment's `kids` array, so the
 * page only opens a streaming boundary under comments that actually have replies.
 */
export async function getThreadHead(id: number): Promise<ThreadHead> {
  const { rows, ms } = await timed(
    async () =>
      (await sql.query(
        `SELECT 0 AS depth, ${THREAD_COLUMNS}, false AS has_replies FROM items WHERE id = $1
         UNION ALL
         SELECT 1 AS depth, ${THREAD_COLUMNS}, (kids IS NOT NULL AND array_length(kids, 1) > 0) AS has_replies
           FROM items WHERE parent = $1
         ORDER BY depth, time`,
        [id],
      )) as Row[],
  )
  let root: ThreadItem | null = null
  const topLevel: ThreadTopComment[] = []
  for (const row of rows) {
    if (asInt(row.depth) === 0) root = asThread(row)
    else topLevel.push({ ...asThread(row), hasReplies: Boolean(row.has_replies) })
  }
  return { root, topLevel, ms }
}

/**
 * Phase 2: every reply below the top level (depth >= 2), fetched in one
 * recursive walk over `items_parent_idx` and streamed in after the head paints.
 * The page groups these by parent and hangs each subtree under its top-level
 * comment.
 */
export async function getThreadReplies(id: number): Promise<ThreadItem[]> {
  const rows = (await sql.query(
    `WITH RECURSIVE sub AS (
       SELECT ${THREAD_COLUMNS}, 1 AS depth FROM items WHERE parent = $1
       UNION ALL
       SELECT ${THREAD_COLUMNS.split(', ')
         .map((c) => `i.${c}`)
         .join(', ')}, s.depth + 1
       FROM items i INNER JOIN sub s ON i.parent = s.id
     )
     SELECT ${THREAD_COLUMNS} FROM sub WHERE depth > 1 ORDER BY time`,
    [id],
  )) as Row[]
  return rows.map(asThread)
}

export type JudgedThread = {
  id: number
  title: string | null
  url: string | null
  score: number | null
  descendants: number | null
  time: string | null
  verdict: ThreadVerdict
}

/** All threads that have a Jev verdict, biggest first. Powers the home-page finding banner. */
export async function getJudgedThreads(): Promise<JudgedThread[]> {
  // Served by the partial items_judged_idx (WHERE jev_verdict IS NOT NULL).
  const rows = (await sql.query(
    `SELECT id, title, url, score, descendants, time, jev_verdict
     FROM items WHERE type='story' AND jev_verdict IS NOT NULL
     ORDER BY descendants DESC`,
  )) as Row[]
  return rows.map((r) => ({
    id: asInt(r.id) ?? 0,
    title: (r.title as string | null) ?? null,
    url: (r.url as string | null) ?? null,
    score: asInt(r.score),
    descendants: asInt(r.descendants),
    time: (r.time as string | null) ?? null,
    verdict: r.jev_verdict as ThreadVerdict,
  }))
}

/** Minimum comments a thread needs to appear anywhere in the app. */
export const MIN_COMMENTS = 6

/**
 * The home page browse: threads with at least {@link MIN_COMMENTS} comments,
 * most-discussed first. No type/date/sort options. This is the only ordering.
 * Served by the partial `items_story_comments_idx` index. Each row carries its
 * Jev verdict (present on the scored threads), so the list renders the verdict
 * strip inline where one exists and a plain row otherwise.
 */
export async function getTopThreads(page: number) {
  const offset = (page - 1) * PAGE_SIZE
  const { rows, ms } = await timed(
    async () =>
      (await sql.query(
        // No NULLS LAST: descendants >= MIN_COMMENTS rules out nulls, and matching
        // the index's default DESC (NULLS FIRST) lets items_story_comments_idx
        // supply the order directly instead of sorting ~600k rows.
        `SELECT ${hitColumns(false)}, jev_verdict FROM items
         WHERE type = 'story' AND NOT deleted AND NOT dead
           AND title IS NOT NULL AND title <> '' AND descendants >= ${MIN_COMMENTS}
         ORDER BY descendants DESC, time DESC
         LIMIT $1 OFFSET $2`,
        [PAGE_SIZE, offset],
      )) as Row[],
  )
  return { rows: rows.map(asHomeThread), ms, page }
}

export async function getUserItems(by: string, page: number) {
  const offset = (page - 1) * PAGE_SIZE
  const { rows, ms } = await timed(
    async () =>
      (await sql.query(
        `SELECT ${hitColumns(true)} FROM items
         WHERE "by" = $1 AND NOT deleted AND NOT dead
         ORDER BY time DESC LIMIT $2 OFFSET $3`,
        [by, PAGE_SIZE, offset],
      )) as Row[],
  )
  return { rows: rows.map(asHit), ms, page }
}

export async function typeahead(term: string): Promise<SearchHit[]> {
  if (!term) return []
  if (term.length <= 2) {
    const rows = (await sql.query(
      `SELECT ${hitColumns(false)} FROM items
       WHERE (title ILIKE $1 OR "by" ILIKE $1) AND NOT deleted AND NOT dead
       ORDER BY time DESC LIMIT 8`,
      [`${term}%`],
    )) as Row[]
    return rows.map(asHit)
  }
  const rows = await run(
    200,
    `SELECT ${hitColumns(false)} FROM items
     WHERE type = 'story' AND NOT deleted AND NOT dead AND search_tsv @@ plainto_tsquery('english', $1)
     ORDER BY search_tsv <@> to_bm25query(to_tsvector('english', $1), '${PARTIAL_BM25.story}')
     LIMIT 8`,
    [term],
  )
  return rows.map(asHit)
}
