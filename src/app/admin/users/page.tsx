'use client'

import { useState, useEffect, useCallback, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import { Skeleton } from '@/components/ui/skeleton'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Plus,
  Search,
  MoreHorizontal,
  Eye,
  Shield,
  UserCog,
  Ban,
  CheckCircle2,
  Trash2,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Users,
  Loader2,
  AlertCircle,
} from 'lucide-react'

// ─── Types ───────────────────────────────────────────────────────────────────

interface AdminUser {
  id: string
  email: string
  emailLower: string
  name: string | null
  status: string
  platformRole: string
  locale: string
  avatarUrl: string | null
  lastLoginAt: string | null
  failedLoginCount: number
  lockedUntil: string | null
  createdAt: string
  updatedAt: string
  _count: { sessions: number; workspaceMembers: number }
}

interface UsersResponse {
  data: AdminUser[]
  nextCursor: string | null
  prevCursor: string | null
  total: number
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getCsrfToken(): Promise<string> {
  return fetch('/api/v1/auth/csrf').then((r) => r.json()).then((d) => d.token)
}

function statusColor(status: string) {
  switch (status) {
    case 'ACTIVE':
      return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
    case 'SUSPENDED':
      return 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300 border-red-200 dark:border-red-800'
    case 'DELETED':
      return 'bg-gray-100 text-gray-600 dark:bg-gray-800/40 dark:text-gray-400 border-gray-200 dark:border-gray-700'
    case 'PENDING_VERIFICATION':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border-amber-200 dark:border-amber-800'
    default:
      return 'bg-gray-100 text-gray-600 dark:bg-gray-800/40 dark:text-gray-400 border-gray-200 dark:border-gray-700'
  }
}

function roleColor(role: string) {
  switch (role) {
    case 'PLATFORM_ADMIN':
      return 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300 border-violet-200 dark:border-violet-800'
    case 'SUPPORT':
      return 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300 border-blue-200 dark:border-blue-800'
    case 'USER':
    default:
      return 'bg-gray-100 text-gray-600 dark:bg-gray-800/40 dark:text-gray-400 border-gray-200 dark:border-gray-700'
  }
}

function formatRole(role: string) {
  switch (role) {
    case 'PLATFORM_ADMIN': return 'Admin'
    case 'SUPPORT': return 'Support'
    case 'USER': return 'User'
    default: return role
  }
}

function formatStatus(status: string) {
  return status.replace(/_/g, ' ')
}

function relativeTime(dateStr: string | null): string {
  if (!dateStr) return '\u2014'
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHr = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHr / 24)

  if (diffSec < 60) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHr < 24) return `${diffHr}h ago`
  if (diffDay < 30) return `${diffDay}d ago`
  return date.toLocaleDateString()
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function AdminUsersPage() {
  // ── State ──
  const [users, setUsers] = useState<AdminUser[]>([])
  const [total, setTotal] = useState(0)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [prevCursor, setPrevCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Filters
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [statusFilter, setStatusFilter] = useState('ALL')
  const [roleFilter, setRoleFilter] = useState('ALL')
  const [cursor, setCursor] = useState<string | undefined>(undefined)

  // Mutations
  const [mutating, setMutating] = useState<string | null>(null)

  // Detail dialog
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailUser, setDetailUser] = useState<AdminUser | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  // New user dialog
  const [newUserOpen, setNewUserOpen] = useState(false)
  const [newUserForm, setNewUserForm] = useState({
    name: '',
    email: '',
    password: '',
    platformRole: 'USER',
    status: 'ACTIVE',
  })
  const [newUserSubmitting, setNewUserSubmitting] = useState(false)

  // ── Fetch users ──
  const fetchUsers = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (search) params.set('search', search)
      if (statusFilter !== 'ALL') params.set('status', statusFilter)
      if (roleFilter !== 'ALL') params.set('platformRole', roleFilter)
      if (cursor) params.set('cursor', cursor)
      params.set('limit', '20')

      const res = await fetch(`/api/v1/admin/users?${params.toString()}`)
      if (!res.ok) throw new Error(`Failed to fetch users (${res.status})`)
      const json: UsersResponse = await res.json()
      setUsers(json.data)
      setNextCursor(json.nextCursor)
      setPrevCursor(json.prevCursor)
      setTotal(json.total)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [search, statusFilter, roleFilter, cursor])

  useEffect(() => {
    fetchUsers()
  }, [fetchUsers])

  // Reset cursor when filters change
  useEffect(() => {
    setCursor(undefined)
  }, [search, statusFilter, roleFilter])

  // ── Handlers ──
  const handleSearch = (e: FormEvent) => {
    e.preventDefault()
    setSearch(searchInput)
    setCursor(undefined)
  }

  const handlePrev = () => {
    if (prevCursor) setCursor(prevCursor)
  }

  const handleNext = () => {
    if (nextCursor) setCursor(nextCursor)
  }

  const handleViewDetail = async (userId: string) => {
    setDetailLoading(true)
    setDetailOpen(true)
    try {
      const res = await fetch(`/api/v1/admin/users/${userId}`)
      if (!res.ok) throw new Error('Failed to fetch user')
      setDetailUser(await res.json())
    } catch {
      toast.error('Failed to load user details')
      setDetailOpen(false)
    } finally {
      setDetailLoading(false)
    }
  }

  const handleChangeRole = async (userId: string, newRole: string) => {
    setMutating(userId)
    try {
      const csrf = await getCsrfToken()
      const res = await fetch(`/api/v1/admin/users/${userId}`, {
        method: 'PATCH',
        headers: {
          'X-CSRF-Token': csrf,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ platformRole: newRole }),
      })
      if (!res.ok) throw new Error('Failed to update role')
      toast.success(`Role changed to ${formatRole(newRole)}`)
      fetchUsers()
    } catch {
      toast.error('Failed to change role')
    } finally {
      setMutating(null)
    }
  }

  const handleToggleStatus = async (userId: string, currentStatus: string) => {
    const newStatus = currentStatus === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE'
    setMutating(userId)
    try {
      const csrf = await getCsrfToken()
      const res = await fetch(`/api/v1/admin/users/${userId}`, {
        method: 'PATCH',
        headers: {
          'X-CSRF-Token': csrf,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: newStatus }),
      })
      if (!res.ok) throw new Error(`Failed to ${newStatus === 'SUSPENDED' ? 'suspend' : 'activate'} user`)
      toast.success(`User ${newStatus === 'SUSPENDED' ? 'suspended' : 'activated'}`)
      fetchUsers()
    } catch {
      toast.error(`Failed to ${newStatus === 'SUSPENDED' ? 'suspend' : 'activate'} user`)
    } finally {
      setMutating(null)
    }
  }

  const handleDelete = async (userId: string) => {
    setMutating(userId)
    try {
      const csrf = await getCsrfToken()
      const res = await fetch(`/api/v1/admin/users/${userId}`, {
        method: 'PATCH',
        headers: {
          'X-CSRF-Token': csrf,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'DELETED' }),
      })
      if (!res.ok) throw new Error('Failed to delete user')
      toast.success('User deleted')
      fetchUsers()
    } catch {
      toast.error('Failed to delete user')
    } finally {
      setMutating(null)
    }
  }

  const handleCreateUser = async (e: FormEvent) => {
    e.preventDefault()
    setNewUserSubmitting(true)
    try {
      const csrf = await getCsrfToken()
      const res = await fetch('/api/v1/admin/users', {
        method: 'POST',
        headers: {
          'X-CSRF-Token': csrf,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(newUserForm),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || err.message || `Failed to create user (${res.status})`)
      }
      toast.success('User created successfully')
      setNewUserOpen(false)
      setNewUserForm({ name: '', email: '', password: '', platformRole: 'USER', status: 'ACTIVE' })
      fetchUsers()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create user')
    } finally {
      setNewUserSubmitting(false)
    }
  }

  // ── Pagination display ──
  const startIdx = total === 0 ? 0 : Math.max(1, (cursor ? (prevCursor ? users.length + 1 : total - users.length + 1) : 1))
  const endIdx = startIdx + users.length - 1

  return (
    <div className="p-4 md:p-6 lg:p-8 space-y-6">
      {/* ── Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Users</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage platform users, roles, and account statuses.
          </p>
        </div>
        <Dialog open={newUserOpen} onOpenChange={setNewUserOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2">
              <Plus className="h-4 w-4" />
              New User
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <form onSubmit={handleCreateUser}>
              <DialogHeader>
                <DialogTitle>Create New User</DialogTitle>
                <DialogDescription>
                  Add a new user to the platform. They will receive an email to verify their account.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-4 py-4">
                <div className="grid gap-2">
                  <Label htmlFor="new-name">Name</Label>
                  <Input
                    id="new-name"
                    placeholder="John Doe"
                    value={newUserForm.name}
                    onChange={(e) => setNewUserForm((f) => ({ ...f, name: e.target.value }))}
                    required
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="new-email">Email</Label>
                  <Input
                    id="new-email"
                    type="email"
                    placeholder="john@example.com"
                    value={newUserForm.email}
                    onChange={(e) => setNewUserForm((f) => ({ ...f, email: e.target.value }))}
                    required
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="new-password">Password</Label>
                  <Input
                    id="new-password"
                    type="password"
                    placeholder="Minimum 8 characters"
                    minLength={8}
                    value={newUserForm.password}
                    onChange={(e) => setNewUserForm((f) => ({ ...f, password: e.target.value }))}
                    required
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label>Role</Label>
                    <Select
                      value={newUserForm.platformRole}
                      onValueChange={(v) => setNewUserForm((f) => ({ ...f, platformRole: v }))}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="USER">User</SelectItem>
                        <SelectItem value="SUPPORT">Support</SelectItem>
                        <SelectItem value="PLATFORM_ADMIN">Admin</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label>Status</Label>
                    <Select
                      value={newUserForm.status}
                      onValueChange={(v) => setNewUserForm((f) => ({ ...f, status: v }))}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ACTIVE">Active</SelectItem>
                        <SelectItem value="PENDING_VERIFICATION">Pending Verification</SelectItem>
                        <SelectItem value="SUSPENDED">Suspended</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setNewUserOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={newUserSubmitting}>
                  {newUserSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Create User
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* ── Filters ── */}
      <Card>
        <CardContent className="p-4">
          <form onSubmit={handleSearch} className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search by name or email..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-full sm:w-[180px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Statuses</SelectItem>
                <SelectItem value="ACTIVE">Active</SelectItem>
                <SelectItem value="SUSPENDED">Suspended</SelectItem>
                <SelectItem value="DELETED">Deleted</SelectItem>
                <SelectItem value="PENDING_VERIFICATION">Pending Verification</SelectItem>
              </SelectContent>
            </Select>
            <Select value={roleFilter} onValueChange={setRoleFilter}>
              <SelectTrigger className="w-full sm:w-[160px]">
                <SelectValue placeholder="Role" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Roles</SelectItem>
                <SelectItem value="USER">User</SelectItem>
                <SelectItem value="SUPPORT">Support</SelectItem>
                <SelectItem value="PLATFORM_ADMIN">Admin</SelectItem>
              </SelectContent>
            </Select>
            <Button type="submit" variant="secondary" className="gap-2">
              <Search className="h-4 w-4" />
              <span className="sm:hidden">Search</span>
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* ── Table ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Users className="h-4 w-4" />
            User Accounts
            {total > 0 && (
              <span className="text-sm font-normal text-muted-foreground">
                ({total} total)
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[220px]">Name / Email</TableHead>
                  <TableHead className="w-[100px]">Role</TableHead>
                  <TableHead className="w-[140px]">Status</TableHead>
                  <TableHead className="w-[80px] text-center">Sessions</TableHead>
                  <TableHead className="w-[100px] text-center">Workspaces</TableHead>
                  <TableHead className="w-[100px]">Last Login</TableHead>
                  <TableHead className="w-[110px]">Created</TableHead>
                  <TableHead className="w-[60px]">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  Array.from({ length: 10 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <Skeleton className="h-8 w-8 rounded-full" />
                          <div className="space-y-1.5">
                            <Skeleton className="h-4 w-[140px]" />
                            <Skeleton className="h-3 w-[180px]" />
                          </div>
                        </div>
                      </TableCell>
                      <TableCell><Skeleton className="h-5 w-16 rounded-full" /></TableCell>
                      <TableCell><Skeleton className="h-5 w-24 rounded-full" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-6 mx-auto" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-6 mx-auto" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                      <TableCell><Skeleton className="h-8 w-8" /></TableCell>
                    </TableRow>
                  ))
                ) : error ? (
                  <TableRow>
                    <TableCell colSpan={8}>
                      <div className="flex flex-col items-center justify-center py-16 gap-3">
                        <AlertCircle className="h-10 w-10 text-destructive" />
                        <p className="text-sm text-muted-foreground">{error}</p>
                        <Button variant="outline" size="sm" onClick={fetchUsers} className="gap-2">
                          <RefreshCw className="h-3.5 w-3.5" />
                          Retry
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : users.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8}>
                      <div className="flex flex-col items-center justify-center py-16 gap-3">
                        <Users className="h-12 w-12 text-muted-foreground/30" />
                        <p className="text-sm font-medium text-muted-foreground">No users found</p>
                        <p className="text-xs text-muted-foreground/70">
                          {search || statusFilter !== 'ALL' || roleFilter !== 'ALL'
                            ? 'Try adjusting your search or filters.'
                            : 'Create the first user to get started.'}
                        </p>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  users.map((user) => (
                    <TableRow key={user.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                            {user.name
                              ? user.name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)
                              : user.email[0].toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">
                              {user.name || 'Unnamed User'}
                            </p>
                            <p className="text-xs text-muted-foreground truncate">
                              {user.email}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={roleColor(user.platformRole)}>
                          {formatRole(user.platformRole)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={statusColor(user.status)}>
                          {formatStatus(user.status)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-center text-sm">
                        {user._count.sessions}
                      </TableCell>
                      <TableCell className="text-center text-sm">
                        {user._count.workspaceMembers}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {relativeTime(user.lastLoginAt)}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {formatDate(user.createdAt)}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              disabled={mutating === user.id}
                            >
                              {mutating === user.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <MoreHorizontal className="h-4 w-4" />
                              )}
                              <span className="sr-only">Open menu</span>
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48">
                            <DropdownMenuItem onClick={() => handleViewDetail(user.id)} className="gap-2">
                              <Eye className="h-4 w-4" />
                              View Details
                            </DropdownMenuItem>

                            <DropdownMenuSub>
                              <DropdownMenuSubTrigger className="gap-2">
                                <UserCog className="h-4 w-4" />
                                Change Role
                              </DropdownMenuSubTrigger>
                              <DropdownMenuSubContent>
                                <DropdownMenuItem
                                  onClick={() => handleChangeRole(user.id, 'USER')}
                                  disabled={user.platformRole === 'USER'}
                                >
                                  User
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => handleChangeRole(user.id, 'SUPPORT')}
                                  disabled={user.platformRole === 'SUPPORT'}
                                >
                                  Support
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => handleChangeRole(user.id, 'PLATFORM_ADMIN')}
                                  disabled={user.platformRole === 'PLATFORM_ADMIN'}
                                >
                                  Admin
                                </DropdownMenuItem>
                              </DropdownMenuSubContent>
                            </DropdownMenuSub>

                            <DropdownMenuSeparator />

                            {user.status === 'ACTIVE' ? (
                              <DropdownMenuItem
                                onClick={() => handleToggleStatus(user.id, user.status)}
                                className="gap-2 text-amber-600 focus:text-amber-600"
                              >
                                <Ban className="h-4 w-4" />
                                Suspend User
                              </DropdownMenuItem>
                            ) : user.status === 'SUSPENDED' ? (
                              <DropdownMenuItem
                                onClick={() => handleToggleStatus(user.id, user.status)}
                                className="gap-2 text-emerald-600 focus:text-emerald-600"
                              >
                                <CheckCircle2 className="h-4 w-4" />
                                Activate User
                              </DropdownMenuItem>
                            ) : null}

                            {user.status !== 'DELETED' && (
                              <>
                                <DropdownMenuSeparator />
                                <AlertDialog>
                                  <AlertDialogTrigger asChild>
                                    <DropdownMenuItem
                                      className="gap-2 text-destructive focus:text-destructive"
                                      onSelect={(e) => e.preventDefault()}
                                    >
                                      <Trash2 className="h-4 w-4" />
                                      Delete User
                                    </DropdownMenuItem>
                                  </AlertDialogTrigger>
                                  <AlertDialogContent>
                                    <AlertDialogHeader>
                                      <AlertDialogTitle>Delete User</AlertDialogTitle>
                                      <AlertDialogDescription>
                                        Are you sure you want to delete{' '}
                                        <span className="font-semibold">{user.name || user.email}</span>? This action
                                        will mark the account as deleted and revoke all active sessions. This action
                                        cannot be easily undone.
                                      </AlertDialogDescription>
                                    </AlertDialogHeader>
                                    <AlertDialogFooter>
                                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                                      <AlertDialogAction
                                        onClick={() => handleDelete(user.id)}
                                        className="bg-destructive text-white hover:bg-destructive/90"
                                      >
                                        Delete
                                      </AlertDialogAction>
                                    </AlertDialogFooter>
                                  </AlertDialogContent>
                                </AlertDialog>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {/* ── Pagination ── */}
          {!loading && !error && users.length > 0 && (
            <div className="flex items-center justify-between border-t px-4 py-3">
              <p className="text-sm text-muted-foreground">
                Showing {startIdx}–{endIdx} of {total}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePrev}
                  disabled={!prevCursor || loading}
                  className="gap-1"
                >
                  <ChevronLeft className="h-4 w-4" />
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleNext}
                  disabled={!nextCursor || loading}
                  className="gap-1"
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── User Detail Dialog ── */}
      <Dialog
        open={detailOpen}
        onOpenChange={(open) => {
          if (!open) setDetailUser(null)
          setDetailOpen(open)
        }}
      >
        <DialogContent className="sm:max-w-lg">
          {detailLoading ? (
            <div className="space-y-4 py-6">
              <div className="flex items-center gap-4">
                <Skeleton className="h-14 w-14 rounded-full" />
                <div className="space-y-2">
                  <Skeleton className="h-5 w-40" />
                  <Skeleton className="h-4 w-52" />
                </div>
              </div>
              <Skeleton className="h-px w-full" />
              <div className="grid grid-cols-2 gap-4">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="space-y-1.5">
                    <Skeleton className="h-3 w-20" />
                    <Skeleton className="h-5 w-28" />
                  </div>
                ))}
              </div>
            </div>
          ) : detailUser ? (
            <>
              <DialogHeader>
                <DialogTitle>User Details</DialogTitle>
                <DialogDescription>
                  Detailed information about this user account.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-6">
                {/* Profile header */}
                <div className="flex items-center gap-4">
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-muted text-lg font-semibold">
                    {detailUser.name
                      ? detailUser.name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)
                      : detailUser.email[0].toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-lg font-semibold truncate">
                      {detailUser.name || 'Unnamed User'}
                    </h3>
                    <p className="text-sm text-muted-foreground truncate">{detailUser.email}</p>
                  </div>
                </div>

                {/* Status & Role badges */}
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline" className={statusColor(detailUser.status)}>
                    {formatStatus(detailUser.status)}
                  </Badge>
                  <Badge variant="outline" className={roleColor(detailUser.platformRole)}>
                    <Shield className="mr-1 h-3 w-3" />
                    {formatRole(detailUser.platformRole)}
                  </Badge>
                </div>

                {/* Details grid */}
                <div className="grid grid-cols-2 gap-4 rounded-lg border p-4">
                  <div>
                    <p className="text-xs text-muted-foreground">User ID</p>
                    <p className="text-sm font-mono mt-0.5 truncate" title={detailUser.id}>
                      {detailUser.id.slice(0, 12)}...
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Locale</p>
                    <p className="text-sm font-medium mt-0.5">{detailUser.locale || '\u2014'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Sessions</p>
                    <p className="text-sm font-medium mt-0.5">{detailUser._count.sessions}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Workspaces</p>
                    <p className="text-sm font-medium mt-0.5">{detailUser._count.workspaceMembers}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Last Login</p>
                    <p className="text-sm font-medium mt-0.5">
                      {relativeTime(detailUser.lastLoginAt)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Failed Logins</p>
                    <p className="text-sm font-medium mt-0.5">{detailUser.failedLoginCount}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Locked Until</p>
                    <p className="text-sm font-medium mt-0.5">
                      {detailUser.lockedUntil
                        ? new Date(detailUser.lockedUntil).toLocaleString()
                        : '\u2014'}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Created</p>
                    <p className="text-sm font-medium mt-0.5">
                      {new Date(detailUser.createdAt).toLocaleString()}
                    </p>
                  </div>
                </div>

                <div>
                  <p className="text-xs text-muted-foreground">Last Updated</p>
                  <p className="text-sm font-medium mt-0.5">
                    {new Date(detailUser.updatedAt).toLocaleString()}
                  </p>
                </div>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
