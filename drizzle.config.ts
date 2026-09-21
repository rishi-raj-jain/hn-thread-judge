import { defineConfig } from 'drizzle-kit'

const url = process.env.DATABASE_URL_UNPOOLED
if (!url) throw new Error('Environment variable DATABASE_URL_UNPOOLED is not available.')

export default defineConfig({
  strict: true,
  verbose: true,
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  schema: './src/db/schema.ts',
})
