import type { JevFields } from '@/lib/queries'

const STANCE_STYLE: Record<string, string> = {
  support: 'text-(--jev-support) bg-(--jev-support-bg)',
  critical: 'text-(--jev-critical) bg-(--jev-critical-bg)',
  neutral: 'text-(--jev-neutral) bg-(--jev-neutral-bg)',
}
const STANCE_LABEL: Record<string, string> = { support: 'supportive', critical: 'critical', neutral: 'neutral' }

/** Inline chip under a comment showing Jev's typed judgment of it. */
export function JevBadge({ item }: { item: JevFields }) {
  if (!item.jevStance) return null
  const substance = item.jevSubstance ?? 0
  const dots = Math.max(0, Math.min(3, Math.round(substance + 0.5)))
  return (
    <span className="inline-flex items-center gap-1.5 align-middle text-(length:--text-xs)">
      <span className={`rounded-sm px-1 py-px font-medium ${STANCE_STYLE[item.jevStance] ?? STANCE_STYLE.neutral}`}>Jev: {STANCE_LABEL[item.jevStance]}</span>
      <span className="text-(--hn-gray)" title={`substance ${substance.toFixed(2)} / 2`} aria-label={`substance ${dots} of 3`}>
        {'●'.repeat(dots)}
        <span className="opacity-30">{'●'.repeat(3 - dots)}</span>
      </span>
      {item.jevIsQuestion ? (
        <span className="text-(--hn-gray)" title="Jev flagged this as an open question">
          ?
        </span>
      ) : null}
    </span>
  )
}
