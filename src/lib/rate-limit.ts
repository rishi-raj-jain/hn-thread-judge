/**
 * Per-IP daily quota for on-demand thread judging. Each new judge reserves one
 * slot for the caller's IP for the current day, and the counter resets at the
 * date rollover. Only new judges are counted: already-judged threads and failed
 * attempts are refunded by the caller, so quota tracks real Jev work.
 *
 * State is a single `judge_rate_limit` row per (ip, day) in the same Neon
 * database, so the count is shared across all serverless instances and there is
 * no extra store to run. The reservation is a single atomic upsert.
 */

import { sql } from '@/db'

/** New thread judges allowed per IP per day. */
export const DAILY_JUDGE_LIMIT = 10

const ENSURE_TABLE = `CREATE TABLE IF NOT EXISTS judge_rate_limit (ip text NOT NULL, day date NOT NULL DEFAULT current_date, count integer NOT NULL DEFAULT 0, PRIMARY KEY (ip, day))`

export type Reservation = { allowed: boolean; used: number; limit: number }

function isMissingTable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /judge_rate_limit/.test(message) && /(does not exist|undefined_table|relation)/i.test(message)
}

/**
 * Atomically reserve one judge for `ip` today when under the daily limit. The
 * `WHERE count < limit` guard on the upsert means a rejected attempt never
 * increments the counter, so hammering the endpoint cannot inflate the count.
 * Returns `allowed: false` once the limit is reached.
 */
export async function reserveJudge(ip: string): Promise<Reservation> {
  const text = `INSERT INTO judge_rate_limit (ip, day, count) VALUES ($1, current_date, 1)
     ON CONFLICT (ip, day) DO UPDATE SET count = judge_rate_limit.count + 1
     WHERE judge_rate_limit.count < $2
     RETURNING count`
  const once = async () => (await sql.query(text, [ip, DAILY_JUDGE_LIMIT])) as { count: number }[]

  let rows: { count: number }[]
  try {
    rows = await once()
  } catch (err) {
    // Self-heal if the migration has not been applied on this database yet.
    if (!isMissingTable(err)) throw err
    await sql.query(ENSURE_TABLE)
    rows = await once()
  }

  if (rows.length === 0) return { allowed: false, used: DAILY_JUDGE_LIMIT, limit: DAILY_JUDGE_LIMIT }
  return { allowed: true, used: Number(rows[0].count), limit: DAILY_JUDGE_LIMIT }
}

/** Give a reserved slot back (the thread was already judged, or judging failed). Best effort. */
export async function refundJudge(ip: string): Promise<void> {
  try {
    await sql.query(`UPDATE judge_rate_limit SET count = greatest(count - 1, 0) WHERE ip = $1 AND day = current_date`, [ip])
  } catch {
    // A lost refund only costs the caller one slot for the day, so never fail the request over it.
  }
}
