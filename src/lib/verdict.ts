export type VerdictTone = 'support' | 'critical' | 'neutral'

/**
 * Graded label from the weighted support share. Computed in the UI (not baked
 * into the stored verdict) so the wording can be tuned without re-scoring.
 */
export function labelFor(supportPct: number): { label: string; tone: VerdictTone } {
  if (supportPct >= 65) return { label: 'Overwhelmingly positive', tone: 'support' }
  if (supportPct >= 58) return { label: 'Mostly positive', tone: 'support' }
  if (supportPct >= 53) return { label: 'Leans positive', tone: 'support' }
  if (supportPct > 47) return { label: 'Sharply divided', tone: 'neutral' }
  if (supportPct >= 42) return { label: 'Leans critical', tone: 'critical' }
  if (supportPct >= 30) return { label: 'Mostly critical', tone: 'critical' }
  return { label: 'Overwhelmingly critical', tone: 'critical' }
}

export const TONE_TEXT: Record<VerdictTone, string> = {
  support: 'text-(--jev-support)',
  critical: 'text-(--jev-critical)',
  neutral: 'text-(--jev-neutral)',
}
