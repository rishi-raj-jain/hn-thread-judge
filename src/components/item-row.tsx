import { ItemByline } from '@/components/item-byline'
import { hostFromUrl, itemHeading, stripHtml } from '@/lib/hn'
import type { SearchHit } from '@/lib/queries'
import Link from 'next/link'

/** One search result, styled like a Hacker News front-page row. Titled items
 * (stories, jobs, polls) lead with a headline. Comments show their text. */
export function ItemRow({ item, index }: { item: SearchHit; index?: number }) {
  const isComment = !item.title && (item.type === 'comment' || item.type === 'pollopt')
  const host = hostFromUrl(item.url)
  const href = item.url || `/item/${item.id}`
  const external = Boolean(item.url)

  return (
    <li className="flex gap-1">
      {index != null ? <span className="w-7 shrink-0 pt-0.5 text-right text-(--hn-gray)">{index}.</span> : null}
      <span className="shrink-0 pt-0.5 text-(length:--text-xs) text-(--hn-gray)" aria-hidden>
        ▲
      </span>
      <div className="min-w-0">
        {isComment ? (
          <>
            <ItemByline item={item} />
            <Link href={`/item/${item.id}`} className="mt-0.5 block max-w-prose text-(length:--text-sm) whitespace-pre-wrap text-(--hn-ink) hover:underline">
              {stripHtml(item.snippet)}
            </Link>
          </>
        ) : (
          <>
            <span className="leading-snug">
              <Link href={href} {...(external ? { target: '_blank', rel: 'noreferrer' } : {})} className="hover:underline">
                {itemHeading(item)}
              </Link>
              {host ? <span className="ml-1 text-(length:--text-xs) text-(--hn-gray)">({host})</span> : null}
            </span>
            <ItemByline item={item} comments={item.type === 'story' || item.type === 'poll'} />
          </>
        )}
      </div>
    </li>
  )
}
