export function stripHtml(value: string | null | undefined): string {
  if (!value) return ''
  return value
    .replace(/<p>/gi, '\n\n')
    .replace(/<i>/gi, '')
    .replace(/<\/i>/gi, '')
    .replace(/<pre><code>/gi, '\n')
    .replace(/<\/code><\/pre>/gi, '\n')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>/gi, '$1 ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function hostFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

export function timeAgo(date: Date | string | null | undefined): string {
  if (!date) return ''
  const then = typeof date === 'string' ? new Date(date) : date
  const seconds = Math.max(0, Math.round((Date.now() - then.getTime()) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.round(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.round(days / 365)}y ago`
}

export function itemHeading(item: { type: string; title?: string | null; text?: string | null; snippet?: string | null }): string {
  if (item.title) return item.title
  const snippet = stripHtml(item.text ?? item.snippet)
  if (snippet) return snippet.slice(0, 160)
  return `(${item.type})`
}
