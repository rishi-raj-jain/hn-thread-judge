import { StanceBar } from '@/components/stance-bar'
import { hostFromUrl, timeAgo } from '@/lib/hn'
import type { JudgedThread } from '@/lib/queries'
import { labelFor, TONE_TEXT } from '@/lib/verdict'
import Link from 'next/link'

/** One judged thread in the home-page list: HN-style headline + a Jev verdict strip. */
export function JudgedRow({ thread, index }: { thread: JudgedThread; index: number }) {
  const v = thread.verdict
  const { label, tone } = labelFor(v.weighted.supportPct)
  const host = hostFromUrl(thread.url)
  const href = thread.url || `/item/${thread.id}`
  const external = Boolean(thread.url)

  return (
    <li className="flex gap-1">
      <span className="w-7 shrink-0 pt-0.5 text-right text-(--hn-gray)">{index}.</span>
      <div className="min-w-0 flex-1">
        <span className="leading-snug">
          <Link href={href} {...(external ? { target: '_blank', rel: 'noreferrer' } : {})} className="font-medium hover:underline">
            {thread.title ?? '(untitled)'}
          </Link>
          {host ? <span className="ml-1 text-(length:--text-xs) text-(--hn-gray)">({host})</span> : null}
        </span>

        <div className="text-(length:--text-xs) text-(--hn-gray)">
          {thread.score != null ? <span>{thread.score} points · </span> : null}
          <Link href={`/item/${thread.id}`} className="hover:underline">
            {thread.descendants ?? 0} comments
          </Link>
          <span> · {timeAgo(thread.time)}</span>
        </div>

        <div className="mt-1 max-w-md">
          <div className="flex items-center gap-2">
            <span className={`shrink-0 text-(length:--text-sm) font-bold ${TONE_TEXT[tone]}`}>{label}</span>
            <span className="text-(length:--text-xs) text-(--hn-gray)">
              {v.weighted.supportPct}% pos / {v.weighted.criticalPct}% crit
            </span>
          </div>
          <div className="mt-0.5">
            <StanceBar counts={v.counts} height="h-1.5" />
          </div>
          <div className="mt-0.5 text-(length:--text-xs) text-(--hn-gray)">
            {v.scoredCount} of {v.totalComments} scored ·{' '}
            <Link href={`/item/${thread.id}`} className="hover:underline">
              see the verdict →
            </Link>
          </div>
        </div>
      </div>
    </li>
  )
}
