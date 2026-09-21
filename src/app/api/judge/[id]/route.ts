import { existingVerdict, judgeThread, JudgeError } from '@/lib/judge'
import { DAILY_JUDGE_LIMIT, refundJudge, reserveJudge, type Reservation } from '@/lib/rate-limit'
import { ipAddress } from '@vercel/functions'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const maxDuration = 300

function rateHeaders(r: Reservation): Record<string, string> {
  return { 'X-RateLimit-Limit': String(r.limit), 'X-RateLimit-Remaining': String(Math.max(r.limit - r.used, 0)) }
}

/**
 * POST /api/judge/:id, scores one thread with Jev on the fly and persists the verdict.
 * New judges are rate limited to DAILY_JUDGE_LIMIT per IP per day. Already-judged
 * threads return instantly and do not spend quota, and a failed judge is refunded.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id)
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: 'bad_id', message: 'Invalid thread id.' }, { status: 400 })

  // Already judged: return the stored verdict without touching the quota.
  try {
    const cached = await existingVerdict(id)
    if (cached) return Response.json({ verdict: cached, scored: cached.scoredCount, comments: cached.scoredCount, failed: 0, cached: true, ms: 0 }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    // Fall through to the normal path, which will surface any real error.
  }

  const ip = ipAddress(request) ?? 'unknown'
  const reservation = await reserveJudge(ip)
  if (!reservation.allowed) {
    return Response.json(
      { error: 'rate_limited', message: `Daily limit reached. You can judge ${DAILY_JUDGE_LIMIT} new threads per day. Try again tomorrow.`, limit: reservation.limit },
      { status: 429, headers: { 'Cache-Control': 'no-store', ...rateHeaders(reservation) } },
    )
  }

  try {
    const result = await judgeThread(id)
    if (result.cached) await refundJudge(ip) // raced with another judge, so do not charge.
    return Response.json(result, { headers: { 'Cache-Control': 'no-store', ...rateHeaders(reservation) } })
  } catch (err) {
    await refundJudge(ip) // never charge a slot for a judge that failed.
    if (err instanceof JudgeError) return Response.json({ error: err.code, message: err.message }, { status: err.status })
    const message = err instanceof Error ? err.message : 'Judging failed.'
    return Response.json({ error: 'internal', message }, { status: 500 })
  }
}
