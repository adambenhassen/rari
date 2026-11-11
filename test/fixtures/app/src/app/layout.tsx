import type { LayoutProps, Metadata } from 'rari'
import { SiteNav } from './site-nav'
import './globals.css'

export default function Layout({ children, pathname }: LayoutProps) {
  if (pathname === '/stale-render/failure') {
    throw new Error('Intentional root layout composition failure')
  }

  return (
    <html lang="en">
      <head />
      <body className="min-h-screen bg-gray-50">
        <div className="min-h-screen bg-gray-50">
          <SiteNav />
          <main className="max-w-7xl mx-auto px-6 py-8">{children}</main>
        </div>
      </body>
    </html>
  )
}

export const metadata: Metadata = {
  title: 'Test App',
  description: 'rari test fixture app',
}
