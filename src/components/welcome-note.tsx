import { CorpusCount } from '@/components/corpus-count'
import { GithubMark, JevLogo, NeonLogo, VercelMark } from '@/components/logos'
import { SOURCE_URL } from '@/lib/links'
import { Suspense } from 'react'

/** Intro banner shown above the results status line on the home page. */
export function WelcomeNote() {
  return (
    <div className="mb-3 border-l-2 border-(--hn-orange) bg-white px-2 py-1.5 text-(length:--text-sm) text-(--hn-gray)">
      <span className="font-bold text-(--hn-ink)">⚖️ Hacker News Judge</span>
      <br />
      <br />
      The most-discussed threads across{' '}
      <Suspense fallback="the corpus">
        <CorpusCount />
      </Suspense>
      , read comment by comment by{' '}
      <a href="https://typesafe.ai" target="_blank" className="border-b visited:text-(--hn-ink)">
        <JevLogo className="inline-block h-[1.15em] w-auto align-[-0.2em] text-(--hn-ink)" /> Jev
      </a>{' '}
      and reduced to one verdict. Live from{' '}
      <a href="https://neon.com" target="_blank" className="border-b visited:text-(--hn-ink)">
        <NeonLogo className="inline-block h-[1.15em] w-auto align-[-0.2em] text-(--hn-ink)" /> Postgres
      </a>{' '}
      <a href="https://neon.com/docs/extensions/lakebase-text" target="_blank" className="border-b visited:text-(--hn-ink)">
        with BM25 search
      </a>{' '}
      and deployed on{' '}
      <a href="https://vercel.com" target="_blank" className="border-b visited:text-(--hn-ink)">
        <VercelMark className="inline-block h-[0.9em] w-auto align-[-0.05em] text-(--hn-ink)" /> Vercel
      </a>
      .
      <br />
      <br />
      <a href={SOURCE_URL} target="_blank" className="font-bold text-(--hn-orange)">
        <GithubMark className="inline-block h-[1.05em] w-[1.05em] align-[-0.15em]" /> View source
      </a>
    </div>
  )
}
