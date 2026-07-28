'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  ShieldCheck,
  FileText,
  AlertCircle,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Filter,
  ScrollText,
} from 'lucide-react'

// ─── Types ───────────────────────────────────────────────────────

interface AuditLogEntry {
  id: string
  actorType: string
  actorId: string | null
  workspaceId: string | null
  action: string
  targetType: string | null
  targetId: string | null
  ipHash: string | null
  userAgentSummary: string | null
  requestId: string | null
  metadataJson: string | null
  outcome: string
  createdAt: string
}

interface WorkspaceInfo {
  id: string
  name: string
  slug: string
  role: string
  createdAt: string
}

interface AuditResponse {
  items: AuditLogEntry[]
  total: number
  page: number
  pageSize: number
}

// ─── Constants ────────────────────────────────────────────────────

const ACTION_LABELS: Record<string, string> = {
  WORKSPACE_CREATE: 'Workspace created',
  WORKSPACE_UPDATE: 'Workspace updated',
  PROJECT_CREATE: 'Project created',
  PROJECT_UPDATE: 'Project updated',
  PROJECT_DELETE: 'Project deleted',
  MEMBER_INVITE: 'Member invited',
  MEMBER_INVITE_ACCEPT: 'Invitation accepted',
  MEMBER_REMOVE: 'Member removed',
  ROLE_CHANGE: 'Role changed',
  RUN_CREATE: 'Run created',
  RUN_CANCEL: 'Run cancelled',
  RUN_COMPLETE: 'Run completed',
  REPORT_SUBMIT_APPROVAL: 'Report submitted for approval',
  REPORT_APPROVE: 'Report approved',
  REPORT_REJECT: 'Report rejected',
  FINDING_ACKNOWLEDGE: 'Finding acknowledged',
  FINDING_RESOLVE: 'Finding resolved',
  ENVIRONMENT_CREATE: 'Environment created',
  DOMAIN_VERIFY_START: 'Domain verification started',
  DOMAIN_VERIFY_COMPLETE: 'Domain verified',
  LOGIN: 'Login',
  LOGOUT: 'Logout',
}

const ACTION_OPTIONS = [
  { value: '', label: 'All actions' },
  { value: 'WORKSPACE_CREATE', label: 'Workspace created' },
  { value: 'WORKSPACE_UPDATE', label: 'Workspace updated' },
  { value: 'PROJECT_CREATE', label: 'Project created' },
  { value: 'PROJECT_UPDATE', label: 'Project updated' },
  { value: 'PROJECT_DELETE', label: 'Project deleted' },
  { value: 'MEMBER_INVITE', label: 'Member invited' },
  { value: 'MEMBER_INVITE_ACCEPT', label: 'Invitation accepted' },
  { value: 'MEMBER_REMOVE', label: 'Member removed' },
  { value: 'ROLE_CHANGE', label: 'Role changed' },
  { value: 'RUN_CREATE', label: 'Run created' },
  { value: 'RUN_CANCEL', label: 'Run cancelled' },
  { value: 'RUN_COMPLETE', label: 'Run completed' },
  { value: 'REPORT_SUBMIT_APPROVAL', label: 'Report submitted' },
  { value: 'REPORT_APPROVE', label: 'Report approved' },
  { value: 'REPORT_REJECT', label: 'Report rejected' },
  { value: 'FINDING_ACKNOWLEDGE', label: 'Finding acknowledged' },
  { value: 'FINDING_RESOLVE', label: 'Finding resolved' },
  { value: 'ENVIRONMENT_CREATE', label: 'Environment created' },
  { value: 'LOGIN', label: 'Login' },
  { value: 'LOGOUT', label: 'Logout' },
]

// ─── Helpers ─────────────────────────────────────────────────────

function relativeTime(dateStr: string): string {
  const now = Date.now()
  const date = new Date(dateStr).getTime()
  const diffMs = now - date
  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 60) return 'just now'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 30) return `${diffDay}d ago`
  const diffMo = Math.floor(diffDay / 30)
  if (diffMo < 12) return `${diffMo}mo ago`
  return `${Math.floor(diffMo / 12)}y ago`
}

function actionBadgeVariant(action: string): 'default' | 'secondary' | 'outline' | 'destructive' {
  if (action.includes('DELETE') || action.includes('REMOVE') || action.includes('REJECT')) return 'destructive'
  if (action.includes('CREATE') || action.includes('APPROVE') || action.includes('COMPLETE') || action.includes('RESOLVE')) return 'default'
  return 'secondary'
}

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())
}

function actorTypeLabel(type: string): string {
  switch (type) {
    case 'USER':
      return 'User'
    case 'SYSTEM':
      return 'System'
    case 'API_KEY':
      return 'API Key'
    case 'SUPPORT':
      return 'Support'
    default:
      return type
  }
}

function outcomeColor(outcome: string): string {
  switch (outcome) {
    case 'SUCCESS':
      return 'text-emerald-600'
    case 'FAILURE':
      return 'text-red-600'
    case 'DENIED':
      return 'text-amber-600'
    default:
      return 'text-muted-foreground'
  }
}

// ─── Component ───────────────────────────────────────────────────

const PAGE_SIZE = 50

export default function AuditPage() {
  const params = useParams<{ workspaceId: string }>()
  const workspaceId = params.workspaceId

  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null)
  const [logs, setLogs] = useState<AuditLogEntry[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [filterAction, setFilterAction] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadData = useCallback(
    async (p: number, action: string) => {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams({ page: String(p), pageSize: String(PAGE_SIZE) })
        if (action) params.set('action', action)

        const [wsRes, auditRes] = await Promise.all([
          fetch(`/api/v1/workspaces/${workspaceId}`),
          fetch(`/api/v1/workspaces/${workspaceId}/audit-logs?${params.toString()}`),
        ])
        if (!wsRes.ok) throw new Error(`Workspace: ${wsRes.status}`)
        if (!auditRes.ok) throw new Error(`Audit: ${auditRes.status}`)
        const [ws, auditData] = await Promise.all([wsRes.json(), auditRes.json()])
        setWorkspace(ws)
        setLogs(auditData.items ?? [])
        setTotal(auditData.total ?? 0)
        setPage(auditData.page ?? p)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load audit logs')
      } finally {
        setLoading(false)
      }
    },
    [workspaceId],
  )

  useEffect(() => {
    void loadData(1, filterAction)
  }, [filterAction])

  useEffect(() => {
    void loadData(1, '')
  }, [workspaceId])

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const hasPrev = page > 1
  const hasNext = page < totalPages

  function handlePrev() {
    if (hasPrev) void loadData(page - 1, filterAction)
  }

  function handleNext() {
    if (hasNext) void loadData(page + 1, filterAction)
  }

  // ─── Loading skeleton ──────────────────────────────────────────

  if (loading && logs.length === 0) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <header className="border-b bg-card sticky top-0 z-10">
          <div className="mx-auto max-w-6xl px-4 py-4 flex items-center gap-3">
            <Skeleton className="h-8 w-8 rounded-lg" />
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-5 w-4" />
            <Skeleton className="h-5 w-32" />
          </div>
        </header>
        <main className="flex-1 mx-auto max-w-6xl px-4 py-8 w-full">
          <div className="space-y-4">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-10 w-48" />
            <Skeleton className="h-[500px] w-full rounded-lg" />
          </div>
        </main>
      </div>
    )
  }

  // ─── Error state ───────────────────────────────────────────────

  if (error && logs.length === 0) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <header className="border-b bg-card sticky top-0 z-10">
          <div className="mx-auto max-w-6xl px-4 py-4 flex items-center gap-3">
            <div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center text-primary-foreground">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <span className="text-lg font-semibold">ProofPilot</span>
          </div>
        </header>
        <main className="flex-1 mx-auto max-w-6xl px-4 py-8 w-full">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertCircle className="h-5 w-5 text-destructive" />
                Failed to load audit logs
              </CardTitle>
              <CardDescription>{error}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" onClick={() => void loadData(page, filterAction)}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Retry
              </Button>
            </CardContent>
          </Card>
        </main>
        <footer className="border-t bg-card mt-auto">
          <div className="mx-auto max-w-6xl px-4 py-4 text-sm text-muted-foreground">
            © {new Date().getFullYear()} ProofPilot. Automated QA, not penetration testing.
          </div>
        </footer>
      </div>
    )
  }

  // ─── Main content ──────────────────────────────────────────────

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Sticky header */}
      <header className="border-b bg-card sticky top-0 z-10">
        <div className="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <ShieldCheck className="h-6 w-6 text-primary" />
            <span className="text-lg font-semibold">ProofPilot</span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <Link href={`/app/workspaces/${workspaceId}/team`} className="hover:underline text-muted-foreground">
              Team
            </Link>
            <Link href={`/app/workspaces/${workspaceId}/settings`} className="hover:underline text-muted-foreground">
              Settings
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1 mx-auto max-w-6xl px-4 py-8 w-full">
        {/* Breadcrumbs */}
        <nav className="flex items-center gap-2 text-sm text-muted-foreground mb-6">
          <Link href="/app" className="hover:text-foreground">
            Dashboard
          </Link>
          <span>/</span>
          <Link href={`/app/workspaces/${workspaceId}`} className="hover:text-foreground">
            {workspace?.name ?? 'Workspace'}
          </Link>
          <span>/</span>
          <span className="text-foreground font-medium">Audit Log</span>
        </nav>

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <ScrollText className="h-6 w-6" />
              Audit Log
            </h1>
            <p className="text-muted-foreground text-sm">
              {total} event{total !== 1 ? 's' : ''} recorded for this workspace.
            </p>
          </div>

          {/* Filter by action type */}
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground shrink-0" />
            <Select value={filterAction} onValueChange={(v) => setFilterAction(v === '__all__' ? '' : v)}>
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="All actions" />
              </SelectTrigger>
              <SelectContent>
                {ACTION_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value || '__all__'} value={opt.value || '__all__'}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Audit log table */}
        <Card>
          <CardContent className="p-0">
            <div className="max-h-[600px] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[140px] shrink-0">Timestamp</TableHead>
                    <TableHead className="w-[180px] shrink-0">Action</TableHead>
                    <TableHead className="w-[100px] shrink-0 hidden sm:table-cell">Actor</TableHead>
                    <TableHead className="hidden md:table-cell">Description</TableHead>
                    <TableHead className="w-[80px] shrink-0 hidden lg:table-cell">Result</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center py-12 text-muted-foreground">
                        <FileText className="h-10 w-10 mx-auto mb-3 opacity-40" />
                        <p>No audit log entries found.</p>
                      </TableCell>
                    </TableRow>
                  ) : (
                    logs.map((log) => (
                      <TableRow key={log.id}>
                        <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                          <div>{relativeTime(log.createdAt)}</div>
                          <div className="text-xs opacity-70">
                            {new Date(log.createdAt).toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={actionBadgeVariant(log.action)}>
                            {actionLabel(log.action)}
                          </Badge>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell text-sm text-muted-foreground">
                          {actorTypeLabel(log.actorType)}
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-sm">
                          {log.targetType ? (
                            <span>
                              <span className="text-muted-foreground capitalize">{log.targetType.toLowerCase()}</span>
                              {log.targetId ? (
                                <span className="font-mono text-xs ml-1 text-muted-foreground">
                                  {log.targetId.slice(0, 8)}…
                                </span>
                              ) : null}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">
                          <span className={`text-xs font-medium ${outcomeColor(log.outcome)}`}>
                            {log.outcome}
                          </span>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        {/* Pagination */}
        <div className="flex items-center justify-between mt-4 text-sm">
          <span className="text-muted-foreground">
            Page {page} of {totalPages} · {total} total
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={!hasPrev} onClick={handlePrev}>
              <ChevronLeft className="h-4 w-4 mr-1" />
              Previous
            </Button>
            <Button variant="outline" size="sm" disabled={!hasNext} onClick={handleNext}>
              Next
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
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
