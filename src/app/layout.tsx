import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import './globals.css'
import { Toaster } from '@/components/ui/toaster'
import { ThemeProvider } from '@/components/theme-provider'

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
})

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
})

export const metadata: Metadata = {
  title: 'ProofPilot — Automated QA for AI-Built Web Apps',
  description:
    'Ship AI-built apps with evidence, not hope. ProofPilot automatically discovers pages, runs browser-based checks, detects accessibility and responsive problems, and produces client-ready delivery reports.',
  keywords: [
    'automated QA',
    'browser testing',
    'accessibility testing',
    'responsive testing',
    'RTL testing',
    'localization testing',
    'web agency QA',
    'AI app testing',
    'client delivery evidence',
    'ProofPilot',
  ],
  authors: [{ name: 'ProofPilot' }],
  openGraph: {
    title: 'ProofPilot — Automated QA for AI-Built Web Apps',
    description: 'Ship AI-built apps with evidence, not hope.',
    type: 'website',
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  )
}
