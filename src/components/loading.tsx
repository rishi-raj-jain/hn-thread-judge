/** Placeholder rows shown while a Suspense boundary streams in real results. */
export function ResultsLoading({ rows = 8, ranked = true }: { rows?: number; ranked?: boolean }) {
  return (
    <div aria-hidden>
      <p className="mb-3 text-(length:--text-sm) text-(--hn-gray)">loading threads…</p>
      <ol className="flex flex-col gap-2">
        {Array.from({ length: rows }).map((_, i) => (
          <li key={i} className="flex gap-1">
            {ranked ? <span className="w-7 shrink-0 pt-0.5 text-right text-(--hn-gray)">{i + 1}.</span> : null}
            <span className="shrink-0 pt-0.5 text-(length:--text-xs) text-(--hn-gray)">▲</span>
            <div className="min-w-0 flex-1">
              <div className="h-3 max-w-[60%] animate-pulse rounded-xs bg-(--hn-gray-line)" style={{ width: `${45 + ((i * 7) % 45)}%` }} />
              <div className="mt-1.5 h-2 w-1/3 animate-pulse rounded-xs bg-(--hn-gray-line)" />
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

/** Placeholder for a thread page (title + a couple of comment blocks). */
export function ThreadLoading() {
  return (
    <div aria-hidden>
      <p className="mb-3 text-(length:--text-sm) text-(--hn-gray)">loading thread…</p>
      <div className="h-5 w-2/3 animate-pulse rounded-xs bg-(--hn-gray-line)" />
      <div className="mt-4 flex flex-col gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i}>
            <div className="h-2 w-24 animate-pulse rounded-xs bg-(--hn-gray-line)" />
            <div className="mt-1.5 h-3 w-11/12 animate-pulse rounded-xs bg-(--hn-gray-line)" />
          </div>
        ))}
      </div>
    </div>
  )
}
