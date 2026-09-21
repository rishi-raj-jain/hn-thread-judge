'use client'

import { stringifySearchParams, type SearchFilters } from '@/lib/search-params'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, useTransition } from 'react'

const DEBOUNCE_MS = 250

function hrefFor(q: string): string {
  const qs = stringifySearchParams({ q: q || undefined })
  return qs ? `/?${qs}` : '/'
}

/** Just the search box. There are no type/sort/date filters: browsing always
 * lists the most-discussed threads, and a query searches them by relevance. */
export function SearchForm({ filters }: { filters: SearchFilters }) {
  const router = useRouter()
  const [q, setQ] = useState(filters.q ?? '')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The last query text we pushed to the URL. Used to tell our own navigations
  // apart from external ones (back/forward, nav links).
  const pushedRef = useRef(filters.q ?? '')
  const [, startTransition] = useTransition()

  // Only adopt the URL's query when it changed for a reason other than our own
  // typing. This never overwrites the box mid-keystroke or moves the cursor.
  useEffect(() => {
    const urlQ = filters.q ?? ''
    if (urlQ !== pushedRef.current) {
      pushedRef.current = urlQ
      setQ(urlQ)
    }
  }, [filters.q])

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )

  function navigate(nextQ: string) {
    if (timerRef.current) clearTimeout(timerRef.current)
    const trimmed = nextQ.trim()
    pushedRef.current = trimmed
    startTransition(() => router.replace(hrefFor(trimmed)))
  }

  function scheduleQuery(next: string) {
    setQ(next)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => navigate(next), DEBOUNCE_MS)
  }

  return (
    <form
      action="/"
      method="get"
      className="mb-3"
      onSubmit={(event) => {
        event.preventDefault()
        navigate(q)
      }}
    >
      <label className="sr-only" htmlFor="q">
        Search Hacker News threads
      </label>
      <input
        id="q"
        name="q"
        value={q}
        onChange={(event) => scheduleQuery(event.target.value)}
        placeholder="Search threads and comments…"
        autoComplete="off"
        autoFocus
        className="w-full border border-(--hn-gray) bg-white px-2 py-1.5 text-(length:--text-base)"
      />
    </form>
  )
}
