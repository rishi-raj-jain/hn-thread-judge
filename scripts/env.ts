import '@dotenvx/dotenvx/config'

export function unpooledUrl(): string {
  const url = process.env.DATABASE_URL_UNPOOLED
  if (!url) throw new Error('Set DATABASE_URL_UNPOOLED (direct Neon URL) in .env')
  return url
}

export function describeUrl(url: string) {
  const parsed = new URL(url)
  return `${parsed.username}@${parsed.hostname}${parsed.pathname}`
}
