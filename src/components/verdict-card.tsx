import { StanceBar, StanceLegend } from '@/components/stance-bar'
import type { ThreadVerdict, VerdictQuote } from '@/db/schema'
import { labelFor, TONE_TEXT } from '@/lib/verdict'
import Link from 'next/link'

function Quote({ label, quote, tone }: { label: string; quote: VerdictQuote | null; tone: 'support' | 'critical' | 'neutral' }) {
  if (!quote) return null
  const bar = tone === 'support' ? 'border-(--jev-support)' : tone === 'critical' ? 'border-(--jev-critical)' : 'border-(--jev-neutral)'
  return (
    <div className={`border-l-2 ${bar} pl-2`}>
      <div className="text-(length:--text-xs) font-bold tracking-wide text-(--hn-gray) uppercase">{label}</div>
      <p className="mt-0.5 text-(length:--text-sm) whitespace-pre-wrap">{quote.text}</p>
      <div className="mt-0.5 text-(length:--text-xs) text-(--hn-gray)">
        {quote.by ? (
          <Link href={`/user/${quote.by}`} className="hover:underline">
            {quote.by}
          </Link>
        ) : (
          'deleted'
        )}
        <span className="mx-1">·</span>
        <Link href={`/item/${quote.id}`} className="hover:underline">
          read in thread
        </Link>
      </div>
    </div>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="min-w-0">
      <div className="text-(length:--text-lg) leading-none font-bold">{value}</div>
      <div className="text-(length:--text-xs) text-(--hn-gray)">{label}</div>
    </div>
  )
}

/** The Jev verdict card shown atop a scored thread. Everything here is derived
 * deterministically from Jev's typed per-comment judgments, with no generated prose. */
export function VerdictCard({ verdict }: { verdict: ThreadVerdict }) {
  const { weighted, counts } = verdict
  const { label, tone } = labelFor(weighted.supportPct)
  return (
    <section className="rounded-md border border-(--jev-card-line) bg-(--jev-card-bg) p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        <span className="rounded-sm bg-(--hn-orange) px-1.5 py-px text-(length:--text-xs) font-bold text-white">JEV VERDICT</span>
        <span className="text-(length:--text-xs) text-(--hn-gray)">
          {verdict.scoredCount.toLocaleString()} of {verdict.totalComments.toLocaleString()} comments scored by Jev
        </span>
      </div>

      <h2 className={`mt-2 text-(length:--text-lg) leading-tight font-bold ${TONE_TEXT[tone]}`}>{label}</h2>
      <p className="text-(length:--text-sm) text-(--hn-gray)">
        {weighted.supportPct}% supportive / {weighted.criticalPct}% critical
        <span className="opacity-70">, weighted by how substantive each comment is</span>
      </p>

      <div className="mt-2">
        <StanceBar counts={counts} />
        <div className="mt-1">
          <StanceLegend counts={counts} />
        </div>
      </div>

      <div className="mt-3 flex gap-6 border-y border-(--jev-card-line) py-2">
        <Stat value={`${verdict.substanceAvg.toFixed(2)}`} label="avg substance / 2" />
        <Stat value={`${verdict.counts.support + verdict.counts.critical}`} label="took a side" />
        <Stat value={`${verdict.questionCount}`} label="open questions" />
      </div>

      <div className="mt-3 flex flex-col gap-2.5">
        <Quote label="Strongest supportive take" quote={verdict.strongestSupport} tone="support" />
        <Quote label="Strongest critique" quote={verdict.strongestCritique} tone="critical" />
        {verdict.bestContrarian ? (
          <Quote label={`Best contrarian (buried ${verdict.bestContrarian.side === 'support' ? 'supportive' : 'critical'} take)`} quote={verdict.bestContrarian} tone={verdict.bestContrarian.side} />
        ) : null}
      </div>

      {verdict.openQuestions.length ? (
        <div className="mt-3 border-t border-(--jev-card-line) pt-2">
          <div className="text-(length:--text-xs) font-bold tracking-wide text-(--hn-gray) uppercase">Questions the thread never settled</div>
          <ul className="mt-1 flex flex-col gap-1">
            {verdict.openQuestions.map((q) => (
              <li key={q.id} className="text-(length:--text-sm)">
                <span className="text-(--hn-gray)">“</span>
                {q.text}
                <span className="text-(--hn-gray)">” </span>
                <Link href={`/item/${q.id}`} className="text-(length:--text-xs) text-(--hn-gray) hover:underline">
                  by {q.by ?? 'deleted'}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="mt-3 text-(length:--text-xs) text-(--hn-gray)">
        Each comment was classified independently by <span className="font-medium">Jev</span> (TypeSafe System One) into a typed stance, substance score and quotability. This card is assembled from those numbers.
      </p>
    </section>
  )
}
