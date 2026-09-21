import { typeahead } from '@/lib/queries'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const maxDuration = 300

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get('q') ?? ''
  const rows = q ? await typeahead(q) : []
  return Response.json(rows)
}
