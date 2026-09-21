import { ItemByline } from '@/components/item-byline'
import { JevBadge } from '@/components/jev-badge'
import { JudgeButton } from '@/components/judge-button'
import { ThreadLoading } from '@/components/loading'
import { QueryMeta } from '@/components/query-meta'
import { VerdictCard } from '@/components/verdict-card'
import { itemHeading, stripHtml, timeAgo } from '@/lib/hn'
import { getThreadHead, getThreadReplies, type ThreadItem } from '@/lib/queries'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'

/** Groups the phase-2 reply rows by their parent id, so a subtree can be looked up. */
function groupByParent(rows: ThreadItem[]): Map<number, ThreadItem[]> {
  const byParent = new Map<number, ThreadItem[]>()
  for (const row of rows) {
    const key = row.parent ?? -1
    const list = byParent.get(key) ?? []
    list.push(row)
    byParent.set(key, list)
  }
  return byParent
}

/** One comment's own content (meta line + body), shared by the top-level list and
 *  the streamed reply subtrees so both render identically. */
function CommentSelf({ item }: { item: ThreadItem }) {
  return (
    <>
      <div className="text-(length:--text-xs) text-(--hn-gray)">
        {item.by ? (
          <Link href={`/user/${item.by}`} className="hover:underline">
            {item.by}
          </Link>
        ) : (
          'deleted'
        )}{' '}
        {timeAgo(item.time)}
        {item.jevStance ? (
          <>
            {' '}
            <span className="mx-1">·</span> <JevBadge item={item} />
          </>
        ) : null}
      </div>
      <div className="max-w-prose text-(length:--text-sm) whitespace-pre-wrap">{item.deleted ? '[deleted]' : stripHtml(item.text)}</div>
    </>
  )
}

/** Recursively renders the children of `parentId` from the grouped reply map. */
function Comments({ parentId, byParent, depth }: { parentId: number; byParent: Map<number, ThreadItem[]>; depth: number }) {
  const kids = byParent.get(parentId) ?? []
  if (!kids.length) return null
  return (
    <ul className={depth === 0 ? 'mt-4 flex flex-col gap-3' : 'mt-2 ml-3 flex flex-col gap-2 border-l border-(--hn-gray-line) pl-3'}>
      {kids.map((item) => (
        <li key={item.id} className="min-w-0">
          <CommentSelf item={item} />
          <Comments parentId={item.id} byParent={byParent} depth={depth + 1} />
        </li>
      ))}
    </ul>
  )
}

/** Streams in the reply subtree under one top-level comment. Every instance awaits
 *  the same grouped-tree promise, so the whole thread is two queries, not one per
 *  comment: React flushes these boundaries together once phase 2 resolves. */
async function Replies({ parentId, tree }: { parentId: number; tree: Promise<Map<number, ThreadItem[]>> }) {
  const byParent = await tree
  return <Comments parentId={parentId} byParent={byParent} depth={1} />
}

/** Indented placeholder shown under a top-level comment while its replies stream in. */
function RepliesLoading() {
  return (
    <div className="mt-2 ml-3 border-l border-(--hn-gray-line) pl-3" aria-hidden>
      <div className="h-2 w-24 animate-pulse rounded-xs bg-(--hn-gray-line)" />
      <div className="mt-1.5 h-3 w-4/5 animate-pulse rounded-xs bg-(--hn-gray-line)" />
    </div>
  )
}

async function Thread({ id }: { id: number }) {
  // Fire phase 2 immediately so the deep replies fetch overlaps the head query,
  // and group them into a tree once. A floating promise for a 404 is harmless
  // (the catch keeps it from becoming an unhandled rejection).
  const tree = getThreadReplies(id)
    .then(groupByParent)
    .catch(() => new Map<number, ThreadItem[]>())

  const { root, topLevel, ms } = await getThreadHead(id)
  if (!root) notFound()

  const hasComments = topLevel.length > 0
  // The button is display-only (the judge endpoint re-reads the thread itself),
  // so the story's total descendant count is the right number to show.
  const commentCount = root.descendants ?? topLevel.length

  return (
    <article>
      <QueryMeta ms={ms} />
      <h1 className="text-(length:--text-lg) leading-snug font-bold">
        {root.url ? (
          <a href={root.url} target="_blank" rel="noreferrer" className="hover:underline">
            {itemHeading(root)}
          </a>
        ) : (
          itemHeading(root)
        )}
      </h1>
      <div className="mt-0.5">
        <ItemByline item={root} />
      </div>
      {root.text ? <div className="mt-3 max-w-prose text-(length:--text-sm) whitespace-pre-wrap">{stripHtml(root.text)}</div> : null}
      {root.jevVerdict ? (
        <div className="mt-4">
          <VerdictCard verdict={root.jevVerdict} />
        </div>
      ) : root.type === 'story' && hasComments ? (
        <div className="mt-4">
          <JudgeButton id={id} comments={commentCount} />
        </div>
      ) : null}

      {hasComments ? (
        <ul className="mt-4 flex flex-col gap-3">
          {topLevel.map((item) => (
            <li key={item.id} className="min-w-0">
              <CommentSelf item={item} />
              {item.hasReplies ? (
                <Suspense fallback={<RepliesLoading />}>
                  <Replies parentId={item.id} tree={tree} />
                </Suspense>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  )
}

export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id)
  if (!Number.isFinite(id)) notFound()
  return (
    <Suspense key={id} fallback={<ThreadLoading />}>
      <Thread id={id} />
    </Suspense>
  )
}
