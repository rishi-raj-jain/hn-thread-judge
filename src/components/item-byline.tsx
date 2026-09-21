import { timeAgo } from '@/lib/hn'
import type { ItemRecord } from '@/lib/queries'
import Link from 'next/link'

type BylineItem = Pick<ItemRecord, 'id' | 'type' | 'by' | 'time' | 'score' | 'descendants'>

// Points are only meaningful on submissions. HN never shows comment scores.
const SCORED = new Set(['story', 'job', 'poll'])

/** The HN "subtext" line: points, author, age, and a comments link. */
export function ItemByline({ item, comments = false }: { item: BylineItem; comments?: boolean }) {
  return (
    <div className="text-(length:--text-xs) text-(--hn-gray)">
      {SCORED.has(item.type) && item.score != null ? <span>{item.score} points </span> : null}
      {item.by ? (
        <>
          by{' '}
          <Link href={`/user/${item.by}`} className="hover:underline">
            {item.by}
          </Link>{' '}
        </>
      ) : null}
      <span>{timeAgo(item.time)}</span>
      {comments ? (
        <>
          <span className="mx-1">|</span>
          <Link href={`/item/${item.id}`} className="hover:underline">
            {item.descendants ?? 0} comments
          </Link>
        </>
      ) : null}
    </div>
  )
}
