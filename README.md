# Hacker News Judge

The most-discussed threads on Hacker News (only threads with 6+ comments, most comments first), each read comment by comment by [Jev](https://typesafe.ai) and reduced to a single verdict, served live from [Neon Lakebase Postgres](https://neon.com). Full-text search over the whole corpus is included, with BM25 ranking. The UI is styled to feel like a native part of news.ycombinator.com.

## Thread Judge (Jev)

Judged threads render inline on the home page as a Jev verdict strip, and a "The finding" card in the right column is computed live over every judged thread. Each verdict is produced by [Jev](https://typesafe.ai) (TypeSafe System One): every comment (up to 400 per thread, top-level reactions first) is sent to Jev on its own and comes back with a _typed_ judgment: a categorical stance (`support` / `critical` / `neutral`), an ordinal substance score, a 0..1 quotability scalar, and whether it raises an open question. Jev never writes prose, so the verdict card is assembled deterministically from those numbers, and every quote on it is a real comment Jev flagged. Open [`/item/{id}`](src/app/item/[id]/page.tsx) for a judged thread to see the card plus a per-comment stance badge on each judged comment.

Any unjudged thread can be judged on demand: the button on the thread calls [`POST /api/judge/:id`](src/app/api/judge/[id]/route.ts), which scores it with Jev and persists the verdict. New judges are rate limited to `DAILY_JUDGE_LIMIT` (10) per IP per day, tracked in a `judge_rate_limit` row in the same database (see [`rate-limit.ts`](src/lib/rate-limit.ts)). Already-judged threads return the stored verdict without spending quota, and a failed judge is refunded. The request-path pipeline is [`src/lib/judge.ts`](src/lib/judge.ts).

Scoring is additive. The judgments go into nullable `jev_*` columns on `items` (per comment) and a `jev_verdict` jsonb blob on the story row. No existing column or value is touched. To score threads in bulk offline instead of on demand:

```bash
npm run db:judge            # score threads not yet scored
npm run db:judge -- --force # re-score all of them
```

Set `TYPESAFE_API_KEY` in `.env` first. The batch pipeline is in [`scripts/judge-threads.ts`](scripts/judge-threads.ts). The constants `TOP_N`, `CAP` and `CONCURRENCY` at the top tune coverage and speed.

## Design notes

- **[Next.js 16](https://nextjs.org)**: App Router, React Server Components, streaming SSR. Every page ships its shell (masthead, search box) instantly and streams the data through a React `<Suspense>` boundary keyed by the query, so navigating shows a skeleton right away instead of freezing on the previous results. The match count is a second, nested boundary that fills in after the results.
- **[Neon Lakebase Postgres](https://neon.com)** over the `@neondatabase/serverless` HTTP driver. Each request is a stateless SQL-over-HTTP round trip with no connection pool. The compute is pinned (see [`neon.ts`](neon.ts)) so there is no scale-to-zero cold start on the first query.
- **Postgres is the search engine.** `lakebase_text` with a `lakebase_bm25` index does corpus-aware BM25 ranking inside the database.
- **Per-type partial BM25 indexes.** The corpus is 85% comments, so a single shared BM25 index is a trap: it scores only its top `lakebase_bm25.default_limit` candidates (1000 by default) and _then_ applies the `type` filter, silently dropping most stories and nearly all jobs before you see them. Each searchable type gets its own **partial** index whose predicate matches the query's `WHERE` clause:

  ```sql
  CREATE INDEX items_story_bm25   ON items USING lakebase_bm25 (search_tsv) WHERE type = 'story'   AND NOT deleted AND NOT dead;
  CREATE INDEX items_comment_bm25 ON items USING lakebase_bm25 (search_tsv) WHERE type = 'comment' AND NOT deleted AND NOT dead;
  CREATE INDEX items_job_bm25     ON items USING lakebase_bm25 (search_tsv) WHERE type = 'job'     AND NOT deleted AND NOT dead;
  ```

  Ranking and counting now run over the requested type alone, so results are complete and correctly ordered at any page. `all` and the long-tail types (poll, pollopt) fall back to the full-corpus `items_search_bm25` index. The candidate limit is set per query inside a transaction, big enough to cover the page being read and opened to the cap when a residual `by`/`since` filter runs afterward.

- **Match counts race exact against estimated.** Postgres has no cheap exact count for a full-text predicate, and a true `count(*)` is a multi-second walk for broad terms. `countMatches` runs two queries in parallel: an exact count bounded to 1,000 rows with a hard `statement_timeout`, and the planner's instant row estimate. Rare terms count exactly ("515 results"). Broad or awkward multi-word queries fall back to the rounded estimate ("~34,000 results"). The whole thing is bounded to a few hundred milliseconds and streams in, so it never blocks the results.
- **[Drizzle](https://orm.drizzle.team)** for the schema and migrations, **[Tailwind v4](https://tailwindcss.com)** for styling.

See [`src/lib/queries.ts`](src/lib/queries.ts) for the query builder and [`src/app/page.tsx`](src/app/page.tsx) for the streaming boundaries.

## Deployment

Deployed on Vercel in `cle1` (Cleveland), next to the Neon compute in `us-east-2`, to keep the SQL-over-HTTP round trip short. The Neon compute is pinned (see [`neon.ts`](neon.ts)) so the first query after an idle period is not paying a cold start. The dominant cost driver is the pinned Neon compute (no scale-to-zero), not per-request query load.

Set `DATABASE_URL_UNPOOLED` to the direct Neon connection string and `TYPESAFE_API_KEY` to your Jev key (used by the on-demand judge endpoint). Env vars are baked at build time, so redeploy after changing them.

## Local dev

1. **Install and configure.**

   ```bash
   npm install
   cp .env.example .env   # fill in DATABASE_URL_UNPOOLED
   ```

2. **Create the schema and load the corpus.** The seed streams the [ClickHouse Hacker News dataset](https://clickhouse.com/docs/get-started/sample-datasets/hacker-news) straight into Postgres with parallel `COPY`, then builds the indexes. BM25 indexes are opt-in because they are large:

   ```bash
   npm run db:migrate           # extensions + tables + btree/trigram indexes
   npm run db:seed -- --bm25    # download, COPY, generated column, all indexes
   ```

   Useful seed flags: `--streams=8`, `--batch=20000`, `--limit=100000` (small sample), `--skip-download`, `--skip-unzip`.

   Getting Hacker News into the database, and keeping it current, is handled by the companion project [`rishi-raj-jain/hn-search`](https://github.com/rishi-raj-jain/hn-search): the ClickHouse seed, the two-phase [`db:backfill`](scripts/backfill.ts) that closes the late-2021-to-now gap from the [HN Firebase API](https://github.com/HackerNews/API), and an hourly Vercel cron sync that upserts the newest items. This repo shares the same `items` schema and adds the Jev judging layer on top.

3. **Run it.**

   ```bash
   npm run dev
   ```

### Scripts

| Command                          | Purpose                                                                 |
| -------------------------------- | ----------------------------------------------------------------------- |
| `npm run dev` / `build`          | Next.js dev server / production build                                   |
| `npm run typecheck`              | `tsc`                                                                   |
| `npm run format`                 | Prettier over the repo                                                  |
| `npm run db:generate`            | Regenerate Drizzle migrations from `src/db/schema.ts`                   |
| `npm run db:migrate`             | Apply extensions, the `items` table, and the judge/rate-limit additions |
| `npm run db:seed`                | Bulk-load the HN dump (add `--bm25` to build search indexes)            |
| `npm run db:backfill`            | Two-phase (fetch to disk, then load) backfill of the 2021-to-now gap    |
| `npm run db:judge`               | Batch-score the top threads with Jev (add `--force` to re-score)        |
| `tsx scripts/inspect-indexes.ts` | Dump table columns, extensions, and index sizes                         |
