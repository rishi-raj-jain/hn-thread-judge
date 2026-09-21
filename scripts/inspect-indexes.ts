import '@dotenvx/dotenvx/config'
import { Client } from 'pg'

async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED
  if (!url) throw new Error('missing DATABASE_URL_UNPOOLED')
  const c = new Client({ connectionString: url, statement_timeout: 0, query_timeout: 0 })
  await c.connect()
  const indexes = await c.query(`
    SELECT i.relname AS indexname, pg_get_indexdef(i.oid) AS def, am.amname,
           idx.indisunique, idx.indisprimary, pg_relation_size(i.oid) AS bytes
    FROM pg_index idx
    JOIN pg_class t ON t.oid = idx.indrelid
    JOIN pg_class i ON i.oid = idx.indexrelid
    JOIN pg_am am ON am.oid = i.relam
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'items'
    ORDER BY 1
  `)
  const cols = await c.query(`
    SELECT column_name, data_type, is_generated
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='items'
    ORDER BY ordinal_position
  `)
  const exts = await c.query(`SELECT extname FROM pg_extension ORDER BY 1`)
  const invalid = await c.query(`
    SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE NOT i.indisvalid
  `)
  const count = await c.query('SELECT count(*)::text AS n FROM items')
  console.log(
    JSON.stringify(
      {
        count: count.rows[0].n,
        extensions: exts.rows.map((r) => r.extname),
        invalid: invalid.rows,
        columns: cols.rows.map((r) => `${r.column_name}:${r.data_type}${r.is_generated === 'ALWAYS' ? ':generated' : ''}`),
        indexes: indexes.rows.map((r) => ({
          name: r.indexname,
          am: r.amname,
          pk: r.indisprimary,
          unique: r.indisunique,
          mb: Math.round(Number(r.bytes) / 1e6),
          def: r.def,
        })),
      },
      null,
      2,
    ),
  )
  await c.end()
}

main()
