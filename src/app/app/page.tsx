import { redirect } from 'next/navigation'
import Link from 'next/link'
import { requireAuth } from '@/lib/auth-context'
import { listWorkspacesForUser } from '@/lib/workspace-service'
import { db } from '@/lib/db'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'

export const dynamic = 'force-dynamic'

export default async function AppDashboard() {
  let auth
  try {
    auth = await requireAuth()
  } catch {
    redirect('/login')
  }

  const workspaces = await listWorkspacesForUser(auth.userId)

  // Get recent activity for each workspace (latest runs)
  const workspaceStats = await Promise.all(
    workspaces.map(async (w) => {
      const projectCount = await db.project.count({ where: { workspaceId: w.id, status: 'ACTIVE' } })
      const runCount = await db.scanRun.count({ where: { workspaceId: w.id } })
      const openFindings = await db.finding.count({
        where: { workspaceId: w.id, status: { in: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'] } },
      })
      return { ...w, projectCount, runCount, openFindings }
    }),
  )

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center text-primary-foreground font-bold">P</div>
            <span className="text-lg font-semibold">ProofPilot</span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-muted-foreground">{auth.email}</span>
            <form action="/api/v1/auth/logout" method="POST">
              <Button variant="outline" size="sm" asChild>
                <Link href="/login">Sign out</Link>
              </Button>
            </form>
          </div>
        </div>
      </header>

      <main className="flex-1 mx-auto max-w-6xl px-4 py-8 w-full">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold">Your workspaces</h1>
            <p className="text-muted-foreground text-sm">Select a workspace to manage projects and scans.</p>
          </div>
        </div>

        {workspaceStats.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>No workspaces yet</CardTitle>
              <CardDescription>Create your first workspace to start scanning.</CardDescription>
            </CardHeader>
            <CardContent>
              <Button>Create workspace</Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid md:grid-cols-2 gap-4">
            {workspaceStats.map((w) => (
              <Link key={w.id} href={`/app/workspaces/${w.id}`}>
                <Card className="hover:border-primary transition-colors cursor-pointer">
                  <CardHeader>
                    <CardTitle className="flex items-center justify-between">
                      <span>{w.name}</span>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">{w.role}</span>
                    </CardTitle>
                    <CardDescription>{w.slug}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-3 gap-4 text-center">
                      <div>
                        <div className="text-2xl font-bold">{w.projectCount}</div>
                        <div className="text-xs text-muted-foreground">Projects</div>
                      </div>
                      <div>
                        <div className="text-2xl font-bold">{w.runCount}</div>
                        <div className="text-xs text-muted-foreground">Runs</div>
                      </div>
                      <div>
                        <div className="text-2xl font-bold">{w.openFindings}</div>
                        <div className="text-xs text-muted-foreground">Open findings</div>
                      </div>
                    </div>
                    <div className="mt-4 pt-3 border-t">
                      <Link
                        href={`/app/workspaces/${w.id}/billing`}
                        className="text-xs text-primary hover:underline"
                      >
                        View usage & billing →
                      </Link>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}

        <div className="mt-12 rounded-lg border bg-muted/30 p-6">
          <h2 className="text-lg font-semibold mb-2">Demo credentials</h2>
          <p className="text-sm text-muted-foreground mb-3">
            Seeded for local development. Use these to explore the dashboard:
          </p>
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
              <div className="text-xs text-muted-foreground">Admin</div>
              <div className="font-mono">admin@proofpilot.local</div>
              <div className="font-mono text-xs">ProofPilot-Admin-2025!</div>
            </div>
          </div>
        </div>
      </main>

      <footer className="border-t bg-card mt-auto">
        <div className="mx-auto max-w-6xl px-4 py-4 text-sm text-muted-foreground">
          © {new Date().getFullYear()} ProofPilot. Automated QA, not penetration testing.
        </div>
      </footer>
    </div>
  )
}
