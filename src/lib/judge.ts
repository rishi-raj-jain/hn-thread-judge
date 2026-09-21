/**
 * On-demand thread judging for the request path.
 *
 * This is the same pipeline as `scripts/judge-threads.ts`, run for a single
 * thread from a serverless endpoint: every comment (up to {@link CAP}) is sent
 * to Jev (TypeSafe System One) on its own and gets a typed judgment, then the
 * verdict card is assembled deterministically from those typed values. Writes
 * are additive only, the nullable `jev_*` columns and the `jev_verdict` jsonb.
 *
 * It talks to Neon over the same SQL-over-HTTP driver the rest of the app uses,
 * so it stays a set of stateless round trips with no connection pool.
 */

import { sql } from '@/db'
import type { ThreadVerdict } from '@/db/schema'

const CAP = 400 // comments scored per thread (breadth-first, top-level reactions first)
const CONCURRENCY = 12
const MAX_DEPTH = 12
const JEV_URL = 'https://api.typesafe.ai/v1/systemone'

/** Error with a stable code so the route can map it to an HTTP status. */
export class JudgeError extends Error {
  constructor(
    readonly code: 'not_found' | 'not_story' | 'unavailable' | 'no_comments' | 'no_key',
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'JudgeError'
  }
}

function jevKey(): string {
  const key = process.env.TYPESAFE_API_KEY
  if (!key) throw new JudgeError('no_key', 'The judging service is not configured (missing TYPESAFE_API_KEY).', 500)
  return key
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Plain text from HN's stored HTML, trimmed for prompts and storage. */
function stripHtml(value: string | null | undefined): string {
  if (!value) return ''
  return value
    .replace(/<p>/gi, '\n\n')
    .replace(/<\/?(i|b|em|strong|code|pre)>/gi, '')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>/gi, '$1 ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim()
}

function host(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

type Judgment = {
  stance: 'support' | 'critical' | 'neutral'
  stanceConf: number
  substance: number // 0..2
  spice: number // 0..1
  isQuestion: boolean
}

async function askJev(premise: string, comment: string, key: string): Promise<Judgment> {
  const body = {
    model: 'jev-latest',
    state: `Discussion context: ${premise}\n\nA single comment from that discussion:\n"""\n${comment.slice(0, 1600)}\n"""`,
    questions: {
      stance: {
        type: 'choice',
        instructions: "What sentiment does THIS comment express toward the article's subject/thesis?",
        criteria: {
          support: 'positive, approving, or agrees with the article/subject',
          critical: 'negative, skeptical, disapproving, or argues against it',
          neutral: 'off-topic, purely a question, or no clear stance',
        },
      },
      substance: {
        type: 'score',
        instructions: 'How substantive is this comment as an argument or contribution?',
        criteria: ['noise or joke', 'casual remark', 'real substantive argument'],
      },
      spice: {
        type: 'noul',
        instructions: 'How memorable, sharp, or quotable is this comment? 0 = forgettable, 1 = highly quotable.',
      },
      is_question: {
        type: 'choice',
        instructions: 'Is this comment primarily raising an unanswered/open question?',
        criteria: { yes: 'mainly poses an open question', no: 'does not' },
      },
    },
  }

  let lastErr: unknown
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(JEV_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      })
      if (!res.ok) {
        if ([429, 500, 502, 503].includes(res.status) && attempt < 3) {
          await sleep(1500 * (attempt + 1))
          continue
        }
        throw new Error(`Jev ${res.status}: ${(await res.text()).slice(0, 200)}`)
      }
      const a = (await res.json()).answers
      return {
        stance: a.stance.choice,
        stanceConf: a.stance.confidence ?? 0,
        substance: a.substance.score ?? 0,
        spice: a.spice.noul ?? 0,
        isQuestion: a.is_question.choice === 'yes',
      }
    } catch (err) {
      lastErr = err
      if (attempt < 3) await sleep(1500 * (attempt + 1))
    }
  }
  throw lastErr
}

/** Run `worker` over `items` with a fixed number of concurrent slots. */
async function pool<T, R>(items: T[], concurrency: number, worker: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const i = next++
        if (i >= items.length) break
        out[i] = await worker(items[i], i)
      }
    }),
  )
  return out
}

type Comment = { id: number; by: string | null; text: string }
type Scored = Comment & Judgment

function weight(c: Scored): number {
  // Comment scores are not public on HN, so substance is the only signal.
  return 0.3 + c.substance
}

function buildVerdict(story: { id: number; title: string | null; url: string | null; descendants: number | null }, premise: string, scored: Scored[]): ThreadVerdict {
  const support = scored.filter((c) => c.stance === 'support')
  const critical = scored.filter((c) => c.stance === 'critical')
  const neutral = scored.filter((c) => c.stance === 'neutral')
  const wS = support.reduce((s, c) => s + weight(c), 0)
  const wC = critical.reduce((s, c) => s + weight(c), 0)
  const tot = wS + wC || 1
  const supportPct = Math.round((wS / tot) * 100)
  const criticalPct = 100 - supportPct

  const gap = supportPct - criticalPct
  const label = gap > 12 ? 'Crowd leans positive' : gap < -12 ? 'Crowd leans critical' : 'Crowd is split'

  const rank = (c: Scored) => c.substance * (0.5 + c.spice)
  const byRank = (p: Scored[]) => [...p].sort((a, b) => rank(b) - rank(a))
  const quote = (c: Scored | undefined) => (c ? { id: c.id, by: c.by, text: c.text.slice(0, 360) } : null)

  const topSupport = byRank(support)
  const topCritical = byRank(critical)
  const minority = wS <= wC ? topSupport : topCritical
  const minoritySide: 'support' | 'critical' = wS <= wC ? 'support' : 'critical'
  const contrarian = minority[1] ?? minority[0]

  const questions = byRank(scored.filter((c) => c.isQuestion))
    .slice(0, 3)
    .map((c) => ({ id: c.id, by: c.by, text: c.text.slice(0, 240) }))

  return {
    storyId: story.id,
    title: story.title,
    url: story.url,
    host: host(story.url),
    premise,
    scoredCount: scored.length,
    totalComments: story.descendants ?? scored.length,
    counts: { support: support.length, critical: critical.length, neutral: neutral.length },
    weighted: { support: Math.round(wS), critical: Math.round(wC), supportPct, criticalPct },
    verdictLabel: label,
    substanceAvg: Number((scored.reduce((s, c) => s + c.substance, 0) / (scored.length || 1)).toFixed(2)),
    questionCount: scored.filter((c) => c.isQuestion).length,
    strongestSupport: quote(topSupport[0]),
    strongestCritique: quote(topCritical[0]),
    bestContrarian: contrarian ? { ...quote(contrarian)!, side: minoritySide } : null,
    openQuestions: questions,
    scoredAt: new Date().toISOString(),
  }
}

type StoryRow = { id: number; title: string | null; url: string | null; descendants: number | null; type: string; dead: boolean; deleted: boolean; scored: boolean }

export type JudgeResult = { verdict: ThreadVerdict; scored: number; comments: number; failed: number; cached: boolean; ms: number }

/** The stored verdict for a thread, or null if it has not been judged. Cheap, so the
 * route can short-circuit already-judged threads without spending any judging quota. */
export async function existingVerdict(storyId: number): Promise<ThreadVerdict | null> {
  const rows = (await sql.query(`SELECT jev_verdict FROM items WHERE id = $1`, [storyId])) as { jev_verdict: ThreadVerdict | null }[]
  return rows[0]?.jev_verdict ?? null
}

/**
 * Judge a single thread and persist the result. Idempotent: an already-scored
 * thread returns its stored verdict unless `force` is set. Throws {@link JudgeError}
 * for cases the caller should surface (unknown id, not a story, no comments loaded).
 */
export async function judgeThread(storyId: number, opts: { force?: boolean } = {}): Promise<JudgeResult> {
  const t0 = Date.now()
  const key = jevKey()

  const storyRows = (await sql.query(
    `SELECT id, title, url, descendants, type, dead, deleted, (jev_verdict IS NOT NULL) AS scored
     FROM items WHERE id = $1`,
    [storyId],
  )) as StoryRow[]
  const story = storyRows[0]
  if (!story) throw new JudgeError('not_found', 'That thread is not in the corpus.', 404)
  if (story.type !== 'story') throw new JudgeError('not_story', 'Only story threads can be judged.', 400)
  if (story.dead || story.deleted) throw new JudgeError('unavailable', 'This thread is dead or deleted.', 400)

  if (story.scored && !opts.force) {
    const rows = (await sql.query(`SELECT jev_verdict FROM items WHERE id = $1`, [storyId])) as { jev_verdict: ThreadVerdict }[]
    const verdict = rows[0].jev_verdict
    return { verdict, scored: verdict.scoredCount, comments: verdict.scoredCount, failed: 0, cached: true, ms: Date.now() - t0 }
  }

  const premise = `The linked post is titled "${story.title ?? '(untitled)'}"${host(story.url) ? ` (${host(story.url)})` : ''}. The thread is Hacker News commenters reacting to it.`

  const raw = (await sql.query(
    `WITH RECURSIVE thread AS (
       SELECT id, parent, "by", text, 0 AS depth FROM items WHERE id = $1
       UNION ALL
       SELECT c.id, c.parent, c."by", c.text, t.depth + 1
       FROM items c JOIN thread t ON c.parent = t.id
       WHERE c.type = 'comment' AND NOT c.dead AND NOT c.deleted AND t.depth < ${MAX_DEPTH}
     )
     SELECT id, "by", text FROM thread
     WHERE depth > 0 AND text IS NOT NULL AND length(text) > 0
     ORDER BY depth ASC, id ASC
     LIMIT ${CAP}`,
    [storyId],
  )) as { id: number; by: string | null; text: string | null }[]

  const comments: Comment[] = raw.map((r) => ({ id: r.id, by: r.by, text: stripHtml(r.text) })).filter((c) => c.text.length >= 3)
  if (comments.length === 0) throw new JudgeError('no_comments', 'This thread has no comments loaded to judge yet.', 409)

  let failed = 0
  const scored = (
    await pool(comments, CONCURRENCY, async (c) => {
      try {
        const j = await askJev(premise, c.text, key)
        return { ...c, ...j } as Scored
      } catch {
        failed++
        return null
      }
    })
  ).filter((x): x is Scored => x !== null)

  // Persist per-comment judgments in one batched UPDATE (additive columns), so the
  // per-comment badges light up after a refresh, exactly like the offline script.
  if (scored.length) {
    await sql.query(
      `UPDATE items AS i SET
         jev_stance = v.stance, jev_substance = v.substance, jev_spice = v.spice,
         jev_is_question = v.is_question, jev_stance_conf = v.conf, jev_scored_at = now()
       FROM (SELECT
         unnest($1::bigint[]) AS id, unnest($2::text[]) AS stance, unnest($3::real[]) AS substance,
         unnest($4::real[]) AS spice, unnest($5::boolean[]) AS is_question, unnest($6::real[]) AS conf
       ) v WHERE i.id = v.id`,
      [scored.map((c) => c.id), scored.map((c) => c.stance), scored.map((c) => c.substance), scored.map((c) => c.spice), scored.map((c) => c.isQuestion), scored.map((c) => c.stanceConf)],
    )
  }

  const verdict = buildVerdict(story, premise, scored)
  await sql.query(`UPDATE items SET jev_verdict = $2::jsonb, jev_scored_at = now() WHERE id = $1`, [storyId, JSON.stringify(verdict)])

  return { verdict, scored: scored.length, comments: comments.length, failed, cached: false, ms: Date.now() - t0 }
}
