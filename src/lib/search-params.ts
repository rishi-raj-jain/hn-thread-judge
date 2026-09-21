import { ITEM_TYPES, type ItemType } from '@/db/schema'

export const PAGE_SIZE = 20

/**
 * The `lakebase_bm25` index scores at most this many candidates per query
 * (`lakebase_bm25.default_limit`, hard-capped at 65535 by the extension). Used
 * to keep date/score-sorted result pages complete.
 */
export const MAX_CANDIDATES = 65535

/**
 * Exact match counts are cheap only up to a point (walking the BM25 index is
 * O(matches)). Count exactly up to here (~200ms even on the 24M-row comment
 * index). Above it, fall back to the planner's instant estimate.
 */
export const COUNT_CAP = 1000

export type SearchType = 'all' | ItemType
export type SearchSince = '24h' | 'week' | 'month' | 'year' | 'all'
export type SearchSort = 'relevance' | 'date' | 'score' | 'comments'

export type SearchFilters = {
  q?: string
  type: SearchType
  by?: string
  since: SearchSince
  sort?: SearchSort
  page?: string
}

// Jobs are not part of Hacker News Judge, so `?type=job` falls back to stories.
const TYPES = new Set<string>([...ITEM_TYPES.filter((t) => t !== 'job'), 'all'])
const SINCE = new Set<string>(['24h', 'week', 'month', 'year', 'all'])
const SORTS = new Set<string>(['relevance', 'date', 'score', 'comments'])

export function parseSearchParams(params: Record<string, string | string[] | undefined>): SearchFilters {
  const one = (key: string) => {
    const value = params[key]
    return typeof value === 'string' ? value : undefined
  }
  const type = one('type')
  const since = one('since')
  const sort = one('sort')
  return {
    q: one('q')?.trim() || undefined,
    type: type && TYPES.has(type) ? (type as SearchType) : 'story',
    by: one('by')?.trim() || undefined,
    since: since && SINCE.has(since) ? (since as SearchSince) : 'all',
    sort: sort && SORTS.has(sort) ? (sort as SearchSort) : undefined,
    page: one('page'),
  }
}

export function stringifySearchParams(params: Partial<SearchFilters>): string {
  const url = new URLSearchParams()
  if (params.q) url.set('q', params.q)
  if (params.type && params.type !== 'story') url.set('type', params.type)
  if (params.by) url.set('by', params.by)
  if (params.since && params.since !== 'all') url.set('since', params.since)
  if (params.sort) url.set('sort', params.sort)
  if (params.page && params.page !== '1') url.set('page', params.page)
  return url.toString()
}

export function pageNumber(page: string | undefined): number {
  return Math.max(1, Number(page) || 1)
}

export function sinceCutoff(since: SearchFilters['since']): Date | null {
  if (!since || since === 'all') return null
  const day = 24 * 60 * 60 * 1000
  const ms = since === '24h' ? day : since === 'week' ? 7 * day : since === 'month' ? 30 * day : 365 * day
  return new Date(Date.now() - ms)
}

/** Compact approximate label for a large count, e.g. 48750000 -> "~49M", 28700 -> "~29K". */
export function formatCompact(n: number): string {
  if (n >= 1_000_000) return `~${Math.round(n / 1_000_000)}M`
  if (n >= 1_000) return `~${Math.round(n / 1_000)}K`
  return `~${Math.round(n)}`
}

/** Round to two significant figures, e.g. 33718 -> 34000, 2888602 -> 2900000. */
export function roundSignificant(n: number, digits = 2): number {
  if (n <= 0) return 0
  const magnitude = Math.pow(10, Math.floor(Math.log10(n)) - (digits - 1))
  return Math.round(n / magnitude) * magnitude
}

/**
 * Renders the match count. Exact below the cap ("515 results"). Above it, the
 * rounded planner estimate ("~34,000 results"), or a plain "1,000+" if no
 * estimate is available.
 */
export function formatMatches(count: number | null, capped: boolean, estimate: number | null): string {
  if (!capped && count != null) return `${count.toLocaleString()} ${count === 1 ? 'result' : 'results'}`
  if (estimate != null) return `~${roundSignificant(estimate).toLocaleString()} results`
  return 'many results'
}
