import { ItemRow } from '@/components/item-row'
import { ResultsLoading } from '@/components/loading'
import { QueryMeta } from '@/components/query-meta'
import { getUserItems } from '@/lib/queries'
import { PAGE_SIZE, pageNumber } from '@/lib/search-params'
import Link from 'next/link'
import { Suspense } from 'react'

async function UserItems({ by, page }: { by: string; page: number }) {
  const { rows, ms } = await getUserItems(by, page)
  return (
    <>
      <QueryMeta ms={ms} />
      <ol className="mt-2 flex flex-col gap-2">
        {rows.map((item, index) => (
          <ItemRow key={item.id} item={item} index={(page - 1) * PAGE_SIZE + index + 1} />
        ))}
      </ol>
      {rows.length === 0 ? <p className="text-(--hn-gray)">No items from this user.</p> : null}
      {rows.length >= PAGE_SIZE ? (
        <Link href={`/user/${encodeURIComponent(by)}?page=${page + 1}`} className="mt-4 inline-block text-(length:--text-sm)">
          More ›
        </Link>
      ) : null}
    </>
  )
}

export default async function UserPage({ params, searchParams }: { params: Promise<{ by: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const by = decodeURIComponent((await params).by)
  const pageParam = (await searchParams).page
  const page = pageNumber(typeof pageParam === 'string' ? pageParam : undefined)

  return (
    <div>
      <h1 className="text-(length:--text-lg) font-bold">{by}</h1>
      <Suspense key={`${by}#${page}`} fallback={<ResultsLoading rows={6} />}>
        <UserItems by={by} page={page} />
      </Suspense>
    </div>
  )
}
