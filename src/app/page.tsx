import { ItemRow } from '@/components/item-row'
import { JudgedRow } from '@/components/judged-row'
import { ResultsLoading } from '@/components/loading'
import { QueryMeta } from '@/components/query-meta'
import { SearchForm } from '@/components/search-form'
import { WelcomeNote } from '@/components/welcome-note'
import { countMatches, getJudgedThreads, getTopThreads, MIN_COMMENTS, searchItems, type HomeThread, type MatchCount } from '@/lib/queries'
import { PAGE_SIZE, pageNumber, parseSearchParams, stringifySearchParams, type SearchFilters } from '@/lib/search-params'
import Link from 'next/link'
import { Suspense } from 'react'

function hrefWith(filters: SearchFilters, patch: Partial<SearchFilters>): string {
  const qs = stringifySearchParams({ ...filters, ...patch })
  return qs ? `/?${qs}` : '/'
}

/** The one-line hook, computed live over every judged thread, shown as a card in the right column. */
async function FindingCard() {
  let threads
  try {
    threads = await getJudgedThreads()
  } catch {
    return null
  }
  if (threads.length === 0) return null
  const mostPositive = threads.reduce((best, t) => (t.verdict.weighted.supportPct > best.verdict.weighted.supportPct ? t : best), threads[0])
  const netPositive = threads.filter((t) => t.verdict.weighted.supportPct > 50).length
  const totalScored = threads.reduce((s, t) => s + t.verdict.scoredCount, 0)
  return (
    <div className="rounded-md border border-(--jev-card-line) bg-(--jev-card-bg) p-3">
      <div className="text-(length:--text-xs) font-bold tracking-wide text-(--hn-orange) uppercase">The finding</div>
      <p className="mt-1.5 text-(length:--text-base) leading-snug">
        Across the {threads.length} biggest threads on Hacker News, only <span className="font-bold">{netPositive}</span> lean net-positive. The most favorable the crowd ever gets is{' '}
        <span className="font-bold text-(--jev-critical)">{mostPositive.verdict.weighted.supportPct}% supportive</span>, on “{mostPositive.title}”.
      </p>
      <p className="mt-2 text-(length:--text-xs) text-(--hn-gray)">{totalScored.toLocaleString()} comments read one by one by Jev.</p>
    </div>
  )
}

/** One row, rendered identically whether it came from browse or search: a verdict
 * strip when the thread carries a Jev verdict, an HN-style row otherwise. */
function Row({ item, rank }: { item: HomeThread; rank: number }) {
  return item.verdict ? (
    <JudgedRow thread={{ id: item.id, title: item.title, url: item.url, score: item.score, descendants: item.descendants, time: item.time, verdict: item.verdict }} index={rank} />
  ) : (
    <ItemRow item={item} index={rank} />
  )
}

/** Streams in once the query returns. The search box above it stays interactive. */
async function Results({ filters, page }: { filters: SearchFilters; page: number }) {
  const isSearch = Boolean(filters.q)
  // Start the count alongside the search. It streams into its own inner boundary.
  const countPromise: Promise<MatchCount> | undefined = isSearch ? countMatches(filters).catch(() => ({ count: null, capped: false, estimate: null, ms: 0 })) : undefined

  let rows: HomeThread[] = []
  let ms = 0
  let error: string | null = null
  try {
    const result = isSearch ? await searchItems(filters, page) : await getTopThreads(page)
    rows = result.rows
    ms = result.ms
  } catch (err) {
    error = err instanceof Error ? err.message : 'Query failed'
  }

  const prev = page > 1 ? hrefWith(filters, { page: String(page - 1) }) : null
  const next = rows.length >= PAGE_SIZE ? hrefWith(filters, { page: String(page + 1) }) : null

  // The finding card takes the empty right column on the first browse page. When
  // it is not shown, the list keeps the full width.
  const showFinding = !isSearch && page === 1

  const list = (
    <div className="min-w-0 flex-1">
      {isSearch ? (
        <QueryMeta ms={ms} error={error} countPromise={countPromise} />
      ) : (
        <p className="mb-3 text-(length:--text-sm) text-(--hn-gray)">
          Most-discussed threads first · only threads with {MIN_COMMENTS}+ comments · {ms.toFixed(0)} ms
        </p>
      )}

      <ol className="flex flex-col gap-3">
        {rows.map((item, index) => (
          <Row key={item.id} item={item} rank={(page - 1) * PAGE_SIZE + index + 1} />
        ))}
      </ol>

      {!error && rows.length === 0 ? <p className="text-(--hn-gray)">{isSearch ? 'No matches. Try a different query.' : 'No threads yet. Seed the corpus, then refresh.'}</p> : null}

      {prev || next ? (
        <nav className="mt-4 flex gap-3 text-(length:--text-sm)">
          {prev ? <Link href={prev}>‹ Prev</Link> : null}
          {next ? <Link href={next}>More ›</Link> : null}
        </nav>
      ) : null}
    </div>
  )

  if (!showFinding) return list

  return (
    <div className="flex flex-col-reverse gap-4 lg:flex-row lg:items-start">
      {list}
      <aside className="lg:sticky lg:top-3 lg:w-72 lg:shrink-0">
        <FindingCard />
      </aside>
    </div>
  )
}

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const filters = parseSearchParams(await searchParams)
  const page = pageNumber(filters.page)
  // A key that changes with the query resets the boundary, so the skeleton
  // shows on every navigation instead of holding the previous results.
  const key = `${stringifySearchParams(filters)}#${page}`

  return (
    <div>
      <SearchForm filters={filters} />
      <WelcomeNote />
      <Suspense key={key} fallback={<ResultsLoading />}>
        <Results filters={filters} page={page} />
      </Suspense>
    </div>
  )
}
