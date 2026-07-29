'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
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
import { ShieldCheck, Users, UserPlus, Mail, AlertCircle, RefreshCw } from 'lucide-react'

// ─── Types ───────────────────────────────────────────────────────

interface MemberItem {
  id: string
  userId: string
  email: string
  name: string | null
  avatarUrl: string | null
  role: string
  addedAt: string
}

interface WorkspaceInfo {
  id: string
  name: string
  slug: string
  role: string
  plan: { code: string; name: string } | null
  createdAt: string
}

// ─── Helpers ─────────────────────────────────────────────────────

function roleVariant(role: string): 'default' | 'secondary' | 'outline' | 'destructive' {
  switch (role) {
    case 'OWNER':
      return 'default'
    case 'ADMIN':
      return 'secondary'
    case 'MEMBER':
      return 'outline'
    case 'VIEWER':
    case 'CLIENT':
      return 'outline'
    default:
      return 'outline'
  }
}

function roleClassName(role: string): string {
  switch (role) {
    case 'OWNER':
      return ''
    case 'ADMIN':
      return ''
    case 'MEMBER':
      return 'text-muted-foreground'
    case 'VIEWER':
    case 'CLIENT':
      return 'text-muted-foreground bg-muted'
    default:
      return 'text-muted-foreground'
  }
}

function getInitials(name: string | null, email: string): string {
  if (name) {
    const parts = name.trim().split(/\s+/)
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    return name[0].toUpperCase()
  }
  return email[0].toUpperCase()
}

function avatarColor(role: string): string {
  switch (role) {
    case 'OWNER':
      return 'bg-primary text-primary-foreground'
    case 'ADMIN':
      return 'bg-secondary text-secondary-foreground'
    default:
      return 'bg-muted text-muted-foreground'
  }
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

// ─── Component ───────────────────────────────────────────────────

export default function TeamPage() {
  const params = useParams<{ workspaceId: string }>()
  const workspaceId = params.workspaceId

  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null)
  const [members, setMembers] = useState<MemberItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Invitation form state (UI only — no actual API call)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState('MEMBER')

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [wsRes, membersRes] = await Promise.all([
        fetch(`/api/v1/workspaces/${workspaceId}`),
        fetch(`/api/v1/workspaces/${workspaceId}/members`),
      ])
      if (!wsRes.ok) throw new Error(`Workspace: ${wsRes.status}`)
      if (!membersRes.ok) throw new Error(`Members: ${membersRes.status}`)
      const [ws, membersData] = await Promise.all([wsRes.json(), membersRes.json()])
      setWorkspace(ws)
      setMembers(membersData.items ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load team data')
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    void loadData()
  }, [loadData])

  // ─── Loading skeleton ──────────────────────────────────────────

  if (loading) {
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
            <Skeleton className="h-[400px] w-full rounded-lg" />
          </div>
        </main>
      </div>
    )
  }

  // ─── Error state ───────────────────────────────────────────────

  if (error) {
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
                Failed to load team
              </CardTitle>
              <CardDescription>{error}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" onClick={() => void loadData()}>
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
            <Link href={`/app/workspaces/${workspaceId}/settings`} className="hover:underline text-muted-foreground">
              Settings
            </Link>
            <Link href={`/app/workspaces/${workspaceId}/audit`} className="hover:underline text-muted-foreground">
              Audit log
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
          <span className="text-foreground font-medium">Team</span>
        </nav>

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Users className="h-6 w-6" />
              Team Members
            </h1>
            <p className="text-muted-foreground text-sm">
              {members.length} member{members.length !== 1 ? 's' : ''} in this workspace.
            </p>
          </div>
        </div>

        {/* Members table */}
        <Card className="mb-6">
          <CardContent className="p-0">
            <div className="max-h-96 overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[50%]">Member</TableHead>
                    <TableHead className="hidden sm:table-cell">Role</TableHead>
                    <TableHead className="hidden md:table-cell">Joined</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={3} className="text-center py-12 text-muted-foreground">
                        <Users className="h-10 w-10 mx-auto mb-3 opacity-40" />
                        <p>No members yet. Invite someone to get started.</p>
                      </TableCell>
                    </TableRow>
                  ) : (
                    members.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <div
                              className={`h-9 w-9 rounded-full flex items-center justify-center text-sm font-semibold shrink-0 ${avatarColor(m.role)}`}
                            >
                              {getInitials(m.name, m.email)}
                            </div>
                            <div className="min-w-0">
                              <div className="font-medium truncate">{m.name || m.email}</div>
                              <div className="text-xs text-muted-foreground truncate">{m.email}</div>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          <Badge variant={roleVariant(m.role)} className={roleClassName(m.role)}>
                            {m.role}
                          </Badge>
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-muted-foreground text-sm">
                          {formatDate(m.addedAt)}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        {/* Invitation form (UI only) */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <UserPlus className="h-5 w-5" />
              Invite a member
            </CardTitle>
            <CardDescription>
              Send an invitation to add a new member to this workspace.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="flex-1">
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    type="email"
                    placeholder="colleague@example.com"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    className="pl-9"
                  />
                </div>
              </div>
              <Select value={inviteRole} onValueChange={setInviteRole}>
                <SelectTrigger className="w-full sm:w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ADMIN">Admin</SelectItem>
                  <SelectItem value="MEMBER">Member</SelectItem>
                  <SelectItem value="VIEWER">Viewer</SelectItem>
                  <SelectItem value="CLIENT">Client</SelectItem>
                </SelectContent>
              </Select>
              <Button disabled={!inviteEmail.trim()}>
                <UserPlus className="h-4 w-4 mr-2" />
                Invite
              </Button>
            </div>
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
