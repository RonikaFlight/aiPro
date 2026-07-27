import Link from 'next/link'
import { db } from '@/lib/db'
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'

async function getStats() {
  try {
    const [users, workspaces, projects, plans, flags] = await Promise.all([
      db.user.count(),
      db.workspace.count(),
      db.project.count(),
      db.plan.count(),
      db.featureFlag.count(),
    ])
    return { users, workspaces, projects, plans, flags, dbOk: true }
  } catch {
    return { users: 0, workspaces: 0, projects: 0, plans: 0, flags: 0, dbOk: false }
  }
}

const FEATURES = [
  { emoji: '🔒', title: 'Real authentication', desc: 'Argon2id passwords, opaque 256-bit session cookies, TOTP MFA, recovery codes, OAuth adapters.' },
  { emoji: '🗄️', title: 'Real persistence', desc: 'Prisma + SQLite in sandbox (portable to PostgreSQL). Every workspace-owned entity is tenant-scoped.' },
  { emoji: '👁️', title: 'Real browser automation', desc: 'Playwright worker on port 3003 launches isolated browser contexts per scan. Real screenshots, real traces.' },
  { emoji: '📊', title: 'Real findings', desc: 'Deterministic fingerprints, severity rules, lifecycle state machine, auto-reopen on regression.' },
  { emoji: '🛡️', title: 'Real SSRF controls', desc: 'WHATWG URL parsing, IDNA normalization, protocol/IP blocklists, DNS rebinding protection, redirect revalidation.' },
  { emoji: '🌍', title: 'Real i18n + RTL', desc: 'English + Persian UI with full RTL. Scanner checks localization, RTL layout, mixed-direction text.' },
  { emoji: '📄', title: 'Real reports', desc: 'Technical + client-friendly reports, white-label branding, secure share links, PDF export.' },
  { emoji: '⚡', title: 'Real-time progress', desc: 'SSE streaming of run events: queued, validating, crawling, analyzing, journey steps, findings, artifacts.' },
]

export default async function Home() {
  const stats = await getStats()

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center text-primary-foreground font-bold">P</div>
            <span className="text-lg font-semibold">ProofPilot</span>
            <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">v0.1.0 — Phase 1</span>
          </div>
          <nav className="flex gap-3 text-sm">
            <Link href="/login" className="px-3 py-1.5 rounded-md hover:bg-muted">Sign in</Link>
            <Link href="/register" className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90">Get started</Link>
          </nav>
        </div>
      </header>

      <main className="flex-1 mx-auto max-w-6xl px-4 py-12 w-full">
        <section className="text-center mb-16">
          <div className="inline-block px-3 py-1 mb-4 rounded-full bg-muted text-xs text-muted-foreground">Ship AI-built apps with evidence, not hope.</div>
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight mb-6">Automated QA for <span className="text-primary">AI-built web apps</span></h1>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto mb-8">Enter a verified URL. ProofPilot discovers pages, runs real browser checks, detects accessibility, responsive, RTL, and runtime problems, captures screenshots and traces, and produces a client-ready delivery report.</p>
          <div className="flex gap-3 justify-center">
            <Link href="/register" className="px-5 py-2.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 font-medium">Start a free scan</Link>
            <Link href="/demo-target" className="px-5 py-2.5 rounded-md border hover:bg-muted font-medium">View demo target</Link>
          </div>
        </section>

        <section className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-16">
          <StatCard label="Users" value={stats.users} ok={stats.dbOk} />
          <StatCard label="Workspaces" value={stats.workspaces} ok={stats.dbOk} />
          <StatCard label="Projects" value={stats.projects} ok={stats.dbOk} />
          <StatCard label="Plans" value={stats.plans} ok={stats.dbOk} />
        </section>

        <section className="mb-16">
          <h2 className="text-2xl font-semibold mb-8 text-center">What ProofPilot actually does</h2>
          <div className="grid md:grid-cols-2 gap-6">
            {FEATURES.map((f) => (
              <div key={f.title} className="rounded-lg border bg-card p-6">
                <div className="flex items-start gap-4">
                  <div className="h-10 w-10 rounded-md bg-primary/10 flex items-center justify-center shrink-0 text-xl">{f.emoji}</div>
                  <div>
                    <h3 className="font-semibold mb-1">{f.title}</h3>
                    <p className="text-sm text-muted-foreground">{f.desc}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-lg border bg-card p-6 mb-16">
          <h2 className="text-xl font-semibold mb-4">Foundation status (Phase 1)</h2>
          <div className="grid md:grid-cols-2 gap-4 text-sm">
            <div>
              <div className="font-medium mb-2">Infrastructure</div>
              <ul className="space-y-1 text-muted-foreground">
                <li>✓ Next.js 16 App Router on port 3000</li>
                <li>✓ Prisma + SQLite (portable to PostgreSQL)</li>
                <li>✓ Structured JSON logger with secret redaction</li>
                <li>✓ Environment validation with production safety checks</li>
                <li>✓ docker-compose reference for full local stack</li>
              </ul>
            </div>
            <div>
              <div className="font-medium mb-2">Security primitives</div>
              <ul className="space-y-1 text-muted-foreground">
                <li>✓ Argon2id password hashing (64 MiB / 3 iterations)</li>
                <li>✓ AES-256-GCM envelope encryption (secret vault)</li>
                <li>✓ Session cookie helpers (__Host-proofpilot_session)</li>
                <li>✓ CSRF token generation + Origin/Referer validation</li>
                <li>✓ Rate limiting with progressive delay</li>
                <li>✓ SafeTargetUrlService (SSRF controls)</li>
                <li>✓ Permission map + workspace guards</li>
                <li>✓ SQLite-backed BullMQ-compatible queue</li>
                <li>✓ Audit log + security event helpers</li>
              </ul>
            </div>
          </div>
          <div className="mt-4 pt-4 border-t text-xs text-muted-foreground">APP_ENV: {env.APP_ENV} · Database: {stats.dbOk ? 'connected' : 'error'} · Log format: {env.LOG_FORMAT}</div>
        </section>

        <section className="rounded-lg border bg-muted/30 p-6">
          <h2 className="text-xl font-semibold mb-2">Demo credentials</h2>
          <p className="text-sm text-muted-foreground mb-4">Seeded for local development. Never use in production.</p>
          <div className="grid md:grid-cols-3 gap-3 text-sm">
            <div className="rounded-md bg-card p-3 border">
              <div className="text-xs text-muted-foreground">Owner</div>
              <div className="font-mono">owner@proofpilot.local</div>
              <div className="font-mono text-xs">ProofPilot-Owner-2025!</div>
            </div>
            <div className="rounded-md bg-card p-3 border">
              <div className="text-xs text-muted-foreground">Client</div>
              <div className="font-mono">client@proofpilot.local</div>
              <div className="font-mono text-xs">ProofPilot-Client-2025!</div>
            </div>
            <div className="rounded-md bg-card p-3 border">
              <div className="text-xs text-muted-foreground">Platform Admin</div>
              <div className="font-mono">admin@proofpilot.local</div>
              <div className="font-mono text-xs">ProofPilot-Admin-2025!</div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t bg-card mt-auto">
        <div className="mx-auto max-w-6xl px-4 py-6 text-sm text-muted-foreground flex flex-col md:flex-row gap-2 justify-between">
          <div>© {new Date().getFullYear()} ProofPilot. Automated QA, not penetration testing.</div>
          <div className="flex gap-4">
            <Link href="/docs" className="hover:text-foreground">Docs</Link>
            <Link href="/security" className="hover:text-foreground">Security</Link>
            <Link href="/pricing" className="hover:text-foreground">Pricing</Link>
          </div>
        </div>
      </footer>
    </div>
  )
}

function StatCard({ label, value, ok }: { label: string; value: number; ok: boolean }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="text-xs text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-bold mt-1">{ok ? value : '—'}</div>
      {!ok && <div className="text-xs text-destructive">DB error</div>}
    </div>
  )
}
