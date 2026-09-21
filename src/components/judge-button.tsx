'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

type State = 'idle' | 'running' | 'error'

/** Shown atop an unjudged thread: judges it on demand via /api/judge/:id, then
 * refreshes so the server re-renders with the fresh verdict card and badges. */
export function JudgeButton({ id, comments }: { id: number; comments: number }) {
  const router = useRouter()
  const [state, setState] = useState<State>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [retryable, setRetryable] = useState(true)

  async function run() {
    setState('running')
    setMessage(null)
    try {
      const res = await fetch(`/api/judge/${id}`, { method: 'POST' })
      const data = (await res.json().catch(() => ({}))) as { message?: string }
      if (!res.ok) {
        // A 429 (daily limit) is not something retrying will fix, so say so plainly.
        setState('error')
        setRetryable(res.status !== 429)
        setMessage(data.message || 'Judging failed.')
        return
      }
      // The verdict is now in the DB. Re-render the server component to show it.
      router.refresh()
    } catch {
      setState('error')
      setRetryable(true)
      setMessage('Could not reach the judge. Check your connection.')
    }
  }

  const running = state === 'running'

  return (
    <section className="rounded-md border border-(--jev-card-line) bg-(--jev-card-bg) p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        <span className="rounded-sm bg-(--hn-orange) px-1.5 py-px text-(length:--text-xs) font-bold text-white">JEV VERDICT</span>
        <span className="text-(length:--text-xs) text-(--hn-gray)">not judged yet</span>
      </div>

      <p className="mt-2 max-w-prose text-(length:--text-sm) text-(--hn-gray)">
        This thread has not been read by Jev yet. Judge it now and every comment (up to 400) gets a typed stance, substance and quotability, then the whole thread collapses into one verdict.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={run}
          disabled={running}
          className="rounded-sm bg-(--hn-orange) px-3 py-1.5 text-(length:--text-sm) font-bold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-70"
        >
          {running ? 'Judging…' : 'Judge this thread with Jev'}
        </button>
        {running ? <span className="text-(length:--text-xs) text-(--hn-gray)">Reading {comments.toLocaleString()} comments one by one. This can take up to a couple of minutes, so keep this tab open.</span> : null}
      </div>

      {state === 'error' ? (
        <p className="mt-2 text-(length:--text-sm) text-(--jev-critical)">
          {message}
          {retryable ? ' Please try again.' : ''}
        </p>
      ) : null}
    </section>
  )
}
