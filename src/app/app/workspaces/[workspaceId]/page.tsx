import { redirect } from 'next/navigation'
import Link from 'next/link'
import { requireWorkspaceAuth } from '@/lib/auth-context'
import { listProjects } from '@/lib/project-service'
import { db } from '@/lib/db'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Plus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { CreateProjectButton } from '@/components/app/create-project-button'

export const dynamic = 'force-dynamic'

export default async function WorkspaceProjectsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}) {
  const { workspaceId } = await params
  let auth
  try {
    auth = await requireWorkspaceAuth(workspaceId, 'projects.read')
  } catch {
    redirect('/login')
  }

  const projects = await listProjects(workspaceId, auth.userId)
  const workspace = await db.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { name: true, slug: true },
  })

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/app" className="text-sm text-muted-foreground hover:text-foreground">← Workspaces</Link>
            <span className="text-muted-foreground">/</span>
            <span className="text-lg font-semibold">{workspace.name}</span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <Link href={`/app/workspaces/${workspaceId}/team`} className="hover:underline">Team</Link>
            <Link href={`/app/workspaces/${workspaceId}/audit`} className="hover:underline">Audit log</Link>
            <span className="text-muted-foreground">{auth.email}</span>
          </div>
        </div>
      </header>

      <main className="flex-1 mx-auto max-w-6xl px-4 py-8 w-full">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">Projects</h1>
            <p className="text-muted-foreground text-sm">Manage QA projects for this workspace.</p>
          </div>
          <CreateProjectButton workspaceId={workspaceId} />
        </div>

        {projects.length === 0 ? (
          <div className="border rounded-lg p-8 text-center">
            <div className="mx-auto w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-4">
              <Plus className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium mb-1">No projects yet</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Create your first project to start scanning.
            </p>
            <CreateProjectButton workspaceId={workspaceId} />
          </div>
        ) : (
          <div className="grid gap-4">
            {projects.map((p) => (
              <Link key={p.id} href={`/app/projects/${p.id}`}>
                <Card className="hover:border-primary transition-colors cursor-pointer">
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-lg">{p.name}</CardTitle>
                      <Badge variant={p.status === 'ACTIVE' ? 'default' : 'secondary'}>{p.status}</Badge>
                    </div>
                    {p.description && <CardDescription>{p.description}</CardDescription>}
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                      <div>
                        <div className="text-xs text-muted-foreground">URL</div>
                        <div className="font-mono text-xs truncate">{p.productionUrl}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Runs</div>
                        <div className="font-bold">{p.runCount}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Findings</div>
                        <div className="font-bold">{p.findingCount}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Environments</div>
                        <div className="font-bold">{p.environmentCount}</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </main>

      <footer className="border-t bg-card mt-auto">
        <div className="mx-auto max-w-6xl px-4 py-4 text-sm text-muted-foreground">
          © {new Date().getFullYear()} ProofPilot
        </div>
      </footer>
    </div>
  )
}
