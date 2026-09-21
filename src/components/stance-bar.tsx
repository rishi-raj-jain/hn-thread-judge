/** A segmented bar of support / critical / neutral shares, HN-muted. */
export function StanceBar({ counts, height = 'h-2' }: { counts: { support: number; critical: number; neutral: number }; height?: string }) {
  const total = counts.support + counts.critical + counts.neutral || 1
  const seg = (n: number) => `${(n / total) * 100}%`
  return (
    <div className={`flex ${height} w-full overflow-hidden rounded-sm`} role="img" aria-label={`${counts.support} support, ${counts.critical} critical, ${counts.neutral} neutral`}>
      <div style={{ width: seg(counts.support) }} className="bg-(--jev-support)" />
      <div style={{ width: seg(counts.critical) }} className="bg-(--jev-critical)" />
      <div style={{ width: seg(counts.neutral) }} className="bg-(--jev-neutral)" />
    </div>
  )
}

const DOT = {
  support: 'bg-(--jev-support)',
  critical: 'bg-(--jev-critical)',
  neutral: 'bg-(--jev-neutral)',
} as const

export function StanceLegend({ counts }: { counts: { support: number; critical: number; neutral: number } }) {
  const items: [keyof typeof DOT, string, number][] = [
    ['support', 'supportive', counts.support],
    ['critical', 'critical', counts.critical],
    ['neutral', 'neutral', counts.neutral],
  ]
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-(length:--text-xs) text-(--hn-gray)">
      {items.map(([key, label, n]) => (
        <span key={key} className="inline-flex items-center gap-1">
          <span className={`inline-block h-2 w-2 rounded-full ${DOT[key]}`} /> {n} {label}
        </span>
      ))}
    </div>
  )
}
