'use client'

import { useEffect, useState, useCallback } from 'react'
import {
  Card,
  CardContent,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Slider } from '@/components/ui/slider'
import { Progress } from '@/components/ui/progress'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Plus,
  MoreHorizontal,
  Pencil,
  Trash2,
  Flag,
  ShieldAlert,
  Loader2,
} from 'lucide-react'

// ─── Types ───────────────────────────────────────────────────────────────────

interface FeatureFlag {
  id: string
  key: string
  description: string | null
  enabled: boolean
  rolloutPercent: number
  updatedAt: string
}

interface FlagFormData {
  key: string
  description: string
  enabled: boolean
  rolloutPercent: number
}

const emptyForm: FlagFormData = {
  key: '',
  description: '',
  enabled: false,
  rolloutPercent: 100,
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getCsrfToken(): Promise<string> {
  const res = await fetch('/api/v1/auth/csrf')
  const { token } = await res.json()
  return token
}

function relativeTime(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diffMs = now - then
  const seconds = Math.floor(diffMs / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days}d ago`
  if (hours > 0) return `${hours}h ago`
  if (minutes > 0) return `${minutes}m ago`
  return '< 1m ago'
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function FeatureFlagsPage() {
  const [flags, setFlags] = useState<FeatureFlag[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingFlag, setEditingFlag] = useState<FeatureFlag | null>(null)
  const [form, setForm] = useState<FlagFormData>(emptyForm)
  const [formSubmitting, setFormSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<FeatureFlag | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Toggle loading tracking
  const [togglingId, setTogglingId] = useState<string | null>(null)

  // ── Fetch flags ─────────────────────────────────────────────────────────
  const fetchFlags = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/v1/admin/feature-flags')
      if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`)
      const data = await res.json()
      setFlags(Array.isArray(data) ? data : [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchFlags()
  }, [fetchFlags])

  // ── Toggle enabled ──────────────────────────────────────────────────────
  const handleToggle = async (flag: FeatureFlag) => {
    setTogglingId(flag.id)
    try {
      const csrf = await getCsrfToken()
      const res = await fetch(`/api/v1/admin/feature-flags/${flag.id}`, {
        method: 'PATCH',
        headers: {
          'X-CSRF-Token': csrf,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ enabled: !flag.enabled }),
      })
      if (!res.ok) throw new Error(`Failed to update: ${res.status}`)
      setFlags((prev) =>
        prev.map((f) => (f.id === flag.id ? { ...f, enabled: !flag.enabled } : f))
      )
    } catch {
      // Silently fail or toast
    } finally {
      setTogglingId(null)
    }
  }

  // ── Open create dialog ──────────────────────────────────────────────────
  const openCreateDialog = () => {
    setEditingFlag(null)
    setForm(emptyForm)
    setFormError(null)
    setDialogOpen(true)
  }

  // ── Open edit dialog ────────────────────────────────────────────────────
  const openEditDialog = (flag: FeatureFlag) => {
    setEditingFlag(flag)
    setForm({
      key: flag.key,
      description: flag.description ?? '',
      enabled: flag.enabled,
      rolloutPercent: flag.rolloutPercent,
    })
    setFormError(null)
    setDialogOpen(true)
  }

  // ── Submit create/edit ──────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!form.key.trim()) {
      setFormError('Key is required')
      return
    }
    setFormSubmitting(true)
    setFormError(null)

    try {
      const csrf = await getCsrfToken()

      if (editingFlag) {
        const res = await fetch(`/api/v1/admin/feature-flags/${editingFlag.id}`, {
          method: 'PATCH',
          headers: {
            'X-CSRF-Token': csrf,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            description: form.description || null,
            enabled: form.enabled,
            rolloutPercent: form.rolloutPercent,
          }),
        })
        if (!res.ok) throw new Error(`Failed to update: ${res.status}`)
      } else {
        const res = await fetch('/api/v1/admin/feature-flags', {
          method: 'POST',
          headers: {
            'X-CSRF-Token': csrf,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            key: form.key.trim(),
            description: form.description || null,
            enabled: form.enabled,
            rolloutPercent: form.rolloutPercent,
          }),
        })
        if (!res.ok) throw new Error(`Failed to create: ${res.status}`)
      }

      setDialogOpen(false)
      fetchFlags()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setFormSubmitting(false)
    }
  }

  // ── Delete ──────────────────────────────────────────────────────────────
  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const csrf = await getCsrfToken()
      const res = await fetch(`/api/v1/admin/feature-flags/${deleteTarget.id}`, {
        method: 'DELETE',
        headers: {
          'X-CSRF-Token': csrf,
          'Content-Type': 'application/json',
        },
      })
      if (!res.ok) throw new Error(`Failed to delete: ${res.status}`)
      setFlags((prev) => prev.filter((f) => f.id !== deleteTarget.id))
    } catch {
      // Silently fail or toast
    } finally {
      setDeleting(false)
      setDeleteTarget(null)
    }
  }

  // ── Loading skeleton ────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="space-y-6 p-6">
        <div className="flex items-center justify-between">
          <div>
            <Skeleton className="h-8 w-40" />
            <Skeleton className="mt-2 h-4 w-72" />
          </div>
          <Skeleton className="h-10 w-32" />
        </div>
        <Card>
          <CardContent className="p-0">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="flex items-center gap-4 border-b p-4 last:border-b-0">
                <Skeleton className="h-5 w-28" />
                <Skeleton className="h-4 w-48" />
                <Skeleton className="ml-auto h-5 w-10" />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    )
  }

  // ── Error state ─────────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 p-12">
        <ShieldAlert className="h-12 w-12 text-destructive" />
        <p className="text-lg font-medium text-destructive">{error}</p>
        <Button variant="outline" onClick={fetchFlags} className="gap-2">
          Retry
        </Button>
      </div>
    )
  }

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Feature Flags</h1>
          <p className="text-muted-foreground text-sm">
            Manage feature toggles and gradual rollouts across your application
          </p>
        </div>
        <Button onClick={openCreateDialog} className="gap-2">
          <Plus className="h-4 w-4" />
          Create Flag
        </Button>
      </div>

      {/* Empty state */}
      {flags.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Flag className="mb-4 h-12 w-12 text-muted-foreground/40" />
            <p className="text-muted-foreground">No feature flags configured yet.</p>
            <Button
              variant="link"
              onClick={openCreateDialog}
              className="mt-2 gap-1 text-emerald-600 dark:text-emerald-400"
            >
              <Plus className="h-4 w-4" />
              Create your first flag
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Table */}
      {flags.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <div className="max-h-[600px] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[180px]">Key</TableHead>
                    <TableHead className="min-w-[200px]">Description</TableHead>
                    <TableHead className="w-[100px]">Enabled</TableHead>
                    <TableHead className="min-w-[140px]">Rollout</TableHead>
                    <TableHead className="min-w-[100px]">Updated</TableHead>
                    <TableHead className="w-[60px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {flags.map((flag) => (
                    <TableRow key={flag.id}>
                      {/* Key */}
                      <TableCell>
                        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm">
                          {flag.key}
                        </code>
                      </TableCell>

                      {/* Description */}
                      <TableCell className="text-muted-foreground text-sm max-w-[300px] truncate">
                        {flag.description || (
                          <span className="italic text-muted-foreground/50">No description</span>
                        )}
                      </TableCell>

                      {/* Enabled */}
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={flag.enabled}
                            disabled={togglingId === flag.id}
                            onCheckedChange={() => handleToggle(flag)}
                          />
                          {togglingId === flag.id && (
                            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                          )}
                        </div>
                      </TableCell>

                      {/* Rollout */}
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Badge
                            variant="outline"
                            className={
                              flag.enabled
                                ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
                                : ''
                            }
                          >
                            {flag.rolloutPercent}%
                          </Badge>
                          <Progress
                            value={flag.enabled ? flag.rolloutPercent : 0}
                            className="h-1.5 w-16"
                          />
                        </div>
                      </TableCell>

                      {/* Updated */}
                      <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                        {relativeTime(flag.updatedAt)}
                      </TableCell>

                      {/* Actions */}
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <MoreHorizontal className="h-4 w-4" />
                              <span className="sr-only">Actions</span>
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => openEditDialog(flag)} className="gap-2">
                              <Pencil className="h-4 w-4" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => setDeleteTarget(flag)}
                              className="gap-2 text-destructive focus:text-destructive"
                            >
                              <Trash2 className="h-4 w-4" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Create / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{editingFlag ? 'Edit Flag' : 'Create Flag'}</DialogTitle>
            <DialogDescription>
              {editingFlag
                ? 'Update the feature flag configuration.'
                : 'Add a new feature flag to control feature rollouts.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Key */}
            <div className="space-y-2">
              <Label htmlFor="flag-key">Key</Label>
              <Input
                id="flag-key"
                placeholder="e.g. new_dashboard_v2"
                value={form.key}
                readOnly={!!editingFlag}
                onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))}
                className={editingFlag ? 'bg-muted' : ''}
              />
            </div>

            {/* Description */}
            <div className="space-y-2">
              <Label htmlFor="flag-desc">Description</Label>
              <Textarea
                id="flag-desc"
                placeholder="Describe what this flag controls..."
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                rows={3}
              />
            </div>

            {/* Enabled */}
            <div className="flex items-center justify-between rounded-lg border p-3">
              <Label htmlFor="flag-enabled" className="cursor-pointer">Enabled</Label>
              <Switch
                id="flag-enabled"
                checked={form.enabled}
                onCheckedChange={(checked) => setForm((f) => ({ ...f, enabled: checked }))}
              />
            </div>

            {/* Rollout % */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Rollout Percentage</Label>
                <span className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                  {form.rolloutPercent}%
                </span>
              </div>
              <Slider
                value={[form.rolloutPercent]}
                onValueChange={([val]) => setForm((f) => ({ ...f, rolloutPercent: val }))}
                min={0}
                max={100}
                step={1}
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>0%</span>
                <span>50%</span>
                <span>100%</span>
              </div>
            </div>

            {/* Form error */}
            {formError && (
              <p className="text-sm text-destructive">{formError}</p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={formSubmitting}
              className="gap-2"
            >
              {formSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {editingFlag ? 'Save Changes' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Feature Flag</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete{' '}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm">
                {deleteTarget?.key}
              </code>
              ? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-white hover:bg-destructive/90 gap-2"
            >
              {deleting && <Loader2 className="h-4 w-4 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
