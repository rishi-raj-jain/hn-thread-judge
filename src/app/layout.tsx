import type { Metadata } from 'next'
import Link from 'next/link'
import './globals.css'

export const metadata: Metadata = {
  title: {
    default: 'Hacker News Judge',
    template: '%s | Hacker News Judge',
  },
  description: 'The biggest Hacker News threads, each read comment by comment by Jev and reduced to a single verdict, served live from Neon Lakebase Postgres. Full-text search included.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <div className="mx-auto max-w-4xl px-2">
          <header className="hn-masthead flex flex-wrap items-center gap-x-2 gap-y-1 bg-(--hn-orange) px-2 py-1">
            <Link href="/" className="inline-flex h-4.5 w-4.5 shrink-0 items-center justify-center border border-white bg-(--hn-orange) text-[10px] font-bold text-white">
              Y
            </Link>
            <Link href="/" className="font-bold">
              <span className="sm:hidden">HN Judge</span>
              <span className="hidden sm:inline">Hacker News Judge</span>
            </Link>
          </header>

          <main className="bg-(--hn-beige) px-2 py-3">{children}</main>
        </div>
      </body>
    </html>
  )
}
