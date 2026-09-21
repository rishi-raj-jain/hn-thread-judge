/**
 * Apply extension + table SQL from drizzle/. Safe to re-run (IF NOT EXISTS).
 *
 *   npm run db:migrate
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Client } from 'pg'
import { describeUrl, unpooledUrl } from './env'

async function main() {
  const url = unpooledUrl()
  console.log(`› connecting ${describeUrl(url)}`)
  const client = new Client({ connectionString: url, statement_timeout: 0, query_timeout: 0 })
  await client.connect()
  try {
    const [{ db, user }] = (await client.query<{ db: string; user: string }>(`SELECT current_database() AS db, current_user AS "user"`)).rows
    console.log(`› session db=${db} user=${user}`)
    for (const ext of ['lakebase_text', 'pg_trgm']) {
      console.log(`› CREATE EXTENSION ${ext}`)
      await client.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`)
    }
    for (const file of ['drizzle/0001_items.sql', 'drizzle/0003_judge.sql', 'drizzle/0004_rate_limit.sql']) {
      console.log(`› ${file}`)
      await client.query(await readFile(path.join(process.cwd(), file), 'utf8'))
    }
    const { rows } = await client.query<{ extname: string }>(`SELECT extname FROM pg_extension WHERE extname IN ('lakebase_text', 'pg_trgm') ORDER BY 1`)
    console.log(`✓ extensions: ${rows.map((r) => r.extname).join(', ') || '(none)'}`)
    console.log('✓ migrations applied')
  } finally {
    await client.end()
  }
}

main()
