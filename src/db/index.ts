import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import * as schema from './schema'

/**
 * The app talks to Neon over the stateless SQL-over-HTTP transport, so every
 * request is a self-contained round trip with no connection to pool. It uses
 * the direct (unpooled) URL, the same one the migrate and seed scripts read.
 */
function databaseUrl(): string {
  const url = process.env.DATABASE_URL_UNPOOLED
  if (!url) throw new Error('Set DATABASE_URL_UNPOOLED to a Neon connection string.')
  return url
}

export const sql = neon(databaseUrl())

/** Kept for schema-typed access and future ORM use. Migrations read `schema` directly. */
export const db = drizzle(sql, { schema })

export type Timed<T> = { rows: T; ms: number }

/** Runs `fn` and reports how long it took, so the UI can show live query latency. */
export async function timed<T>(fn: () => Promise<T>): Promise<Timed<T>> {
  const started = performance.now()
  const rows = await fn()
  return { rows, ms: performance.now() - started }
}
