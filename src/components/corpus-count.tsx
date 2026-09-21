import { corpusSize } from '@/lib/queries'
import { formatCompact } from '@/lib/search-params'

/** Streams the live corpus size into the footer, estimated from planner stats. */
export async function CorpusCount() {
  const size = await corpusSize()
  return <>{size != null ? `${formatCompact(size)} items` : 'the corpus'}</>
}
