/**
 * Score the top HN threads with Jev (TypeSafe System One).
 *
 * For each of the top {@link TOP_N} threads by comment count, every comment
 * (up to {@link CAP}) is sent to Jev on its own, which returns a *typed*
 * judgment, a categorical stance, an ordinal substance score, a 0..1
 * quotability scalar, and whether it raises an open question. Nothing is
 * generated as prose: the verdict card is assembled deterministically from
 * those typed values, so every quote shown is a real comment Jev flagged.
 *
 * Writes are additive only: per-comment judgments go into the nullable
 * `jev_*` columns on `items`, and the aggregated verdict into `jev_verdict`
 * (jsonb) on the story row. No existing column or value is modified.
 *
 *   npm run db:judge            # score threads that are not yet scored
 *   npm run db:judge -- --force # re-score all of them
 */

import { Client } from 'pg'
import { describeUrl, unpooledUrl } from './env'

const TOP_N = 100
const CAP = 400 // comments scored per thread (breadth-first, top-level reactions first)
const CONCURRENCY = 12
const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
const MAX_DEPTH = 12

function jevKey(): string {
  const key = process.env.TYPESAFE_API_KEY
  if (!key) throw new Error('Set TYPESAFE_API_KEY (Jev key) in .env')
  return key
}

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

function buildVerdict(story: { id: number; title: string | null; url: string | null; descendants: number | null }, premise: string, scored: Scored[]) {
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
  const byRank = (pool: Scored[]) => [...pool].sort((a, b) => rank(b) - rank(a))
  const quote = (c: Scored | undefined) => (c ? { id: c.id, by: c.by, text: c.text.slice(0, 360) } : null)

  const topSupport = byRank(support)
  const topCritical = byRank(critical)
  const minority = wS <= wC ? topSupport : topCritical
  const minoritySide = wS <= wC ? 'support' : 'critical'
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

async function main() {
  const force = process.argv.includes('--force')
  const url = unpooledUrl()
  const key = jevKey()
  console.log(`› connecting ${describeUrl(url)}`)
  const client = new Client({ connectionString: url, statement_timeout: 0, query_timeout: 0 })
  await client.connect()

  try {
    // Additive columns (idempotent), no existing column or value is touched.
    for (const col of ['jev_stance text', 'jev_substance real', 'jev_spice real', 'jev_is_question boolean', 'jev_stance_conf real', 'jev_verdict jsonb', 'jev_scored_at timestamptz']) {
      await client.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS ${col}`)
    }

    const { rows: stories } = await client.query<{ id: number; title: string | null; url: string | null; descendants: number | null; scored: boolean }>(
      `SELECT s.id, s.title, s.url, s.descendants, (s.jev_verdict IS NOT NULL) AS scored
       FROM items s
       WHERE s.type='story' AND NOT s.dead AND NOT s.deleted AND s.descendants IS NOT NULL
         AND EXISTS (SELECT 1 FROM items c WHERE c.parent=s.id AND c.type='comment')
       ORDER BY s.descendants DESC
       LIMIT $1`,
      [TOP_N],
    )

    console.log(`› ${stories.length} threads selected (top ${TOP_N} by comment count)\n`)

    for (const [i, story] of stories.entries()) {
      const tag = `[${i + 1}/${stories.length}] #${story.id} "${(story.title ?? '').slice(0, 50)}"`
      if (story.scored && !force) {
        console.log(`${tag}: already scored, skip (use --force to redo)`)
        continue
      }

      const premise = `The linked post is titled "${story.title ?? '(untitled)'}"${host(story.url) ? ` (${host(story.url)})` : ''}. The thread is Hacker News commenters reacting to it.`

      const { rows: raw } = await client.query<{ id: number; by: string | null; text: string | null }>(
        `WITH RECURSIVE thread AS (
           SELECT id, parent, "by", text, 0 AS depth FROM items WHERE id=$1
           UNION ALL
           SELECT c.id, c.parent, c."by", c.text, t.depth+1
           FROM items c JOIN thread t ON c.parent=t.id
           WHERE c.type='comment' AND NOT c.dead AND NOT c.deleted AND t.depth < ${MAX_DEPTH}
         )
         SELECT id, "by", text FROM thread
         WHERE depth > 0 AND text IS NOT NULL AND length(text) > 0
         ORDER BY depth ASC, id ASC
         LIMIT ${CAP}`,
        [story.id],
      )

      const comments: Comment[] = raw.map((r) => ({ id: r.id, by: r.by, text: stripHtml(r.text) })).filter((c) => c.text.length >= 3)

      const t0 = Date.now()
      let fails = 0
      const scored = (
        await pool(comments, CONCURRENCY, async (c) => {
          try {
            const j = await askJev(premise, c.text, key)
            return { ...c, ...j } as Scored
          } catch {
            fails++
            return null
          }
        })
      ).filter((x): x is Scored => x !== null)

      // Persist per-comment judgments in one batched UPDATE (additive columns).
      if (scored.length) {
        await client.query(
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
      await client.query(`UPDATE items SET jev_verdict = $2::jsonb, jev_scored_at = now() WHERE id = $1`, [story.id, JSON.stringify(verdict)])

      const secs = ((Date.now() - t0) / 1000).toFixed(0)
      console.log(
        `${tag}: scored ${scored.length}/${comments.length} in ${secs}s` +
          `${fails ? ` (${fails} failed)` : ''} → ${verdict.verdictLabel} ` +
          `(${verdict.weighted.supportPct}% pos / ${verdict.weighted.criticalPct}% crit)`,
      )
    }

    // Refresh planner stats so items_judged_idx keeps serving /judged fast as the
    // set of scored stories grows.
    console.log('› ANALYZE items')
    await client.query('ANALYZE items')
    console.log('\n✓ done')
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
