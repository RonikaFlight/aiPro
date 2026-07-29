'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { Search, RefreshCw, Building2, ChevronLeft, ChevronRight } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

interface AdminWorkspace {
  id: string
  name: string
  slug: string
  ownerId: string
  planId: string | null
  logoUrl: string | null
  accentColor: string | null
  brandName: string | null
  customDomain: string | null
  retentionDays: number
  createdAt: string
  updatedAt: string
  owner: { name: string | null; email: string }
  _count: { projects: number; members: number; subscriptions: number }
}

interface WorkspacesResponse {
  data: AdminWorkspace[]
  nextCursor: string | null
  total: number
}

const LIMIT = 20

function relativeTime(dateStr: string): string {
  try {
    return formatDistanceToNow(new Date(dateStr), { addSuffix: true })
  } catch {
    return '—'
  }
}

export default function AdminWorkspacesPage() {
  const [workspaces, setWorkspaces] = useState<AdminWorkspace[]>([])
  const [total, setTotal] = useState(0)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [prevCursors, setPrevCursors] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const fetchWorkspaces = useCallback(
    async (cursor?: string, searchTerm?: string) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setLoading(true)
      setError(null)

      try {
        const params = new URLSearchParams()
        params.set('limit', String(LIMIT))
        if (searchTerm) params.set('search', searchTerm)
        if (cursor) params.set('cursor', cursor)

        const res = await fetch(`/api/v1/admin/workspaces?${params.toString()}`, {
          signal: controller.signal,
        })

        if (!res.ok) {
          throw new Error(`Failed to fetch workspaces (HTTP ${res.status})`)
        }

        const json: WorkspacesResponse = await res.json()
        setWorkspaces(json.data)
        setNextCursor(json.nextCursor)
        setTotal(json.total)
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setError(
          err instanceof Error ? err.message : 'An unexpected error occurred'
        )
        setWorkspaces([])
        setNextCursor(null)
        setTotal(0)
      } finally {
        setLoading(false)
      }
    },
    []
  )

  const handleSearch = () => {
    setSearch(searchInput)
    setPrevCursors([])
    fetchWorkspaces(undefined, searchInput)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') handleSearch()
  }

  const handlePrev = () => {
    const prev = prevCursors[prevCursors.length - 1]
    setPrevCursors((c) => c.slice(0, -1))
    fetchWorkspaces(prev, search)
  }

  const handleNext = () => {
    if (!nextCursor) return
    setPrevCursors((c) => [...c, workspaces[0]?.id ?? ''])
    fetchWorkspaces(nextCursor, search)
  }

  useEffect(() => {
    fetchWorkspaces()
    return () => abortRef.current?.abort()
  }, [fetchWorkspaces])

  const rangeStart = prevCursors.length * LIMIT + 1
  const rangeEnd = Math.min(rangeStart + workspaces.length - 1, total)
  const hasPrev = prevCursors.length > 0
  const hasNext = !!nextCursor && workspaces.length === LIMIT

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      {/* Page header */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Building2 className="h-5 w-5 text-emerald-600" />
          <h1 className="text-2xl font-bold tracking-tight">Workspaces</h1>
          {total > 0 && !loading && (
            <Badge
              variant="secondary"
              className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
            >
              {total}
            </Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Manage and inspect all platform workspaces.
        </p>
      </div>

      {/* Search */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search workspaces by name, slug, or owner..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={handleKeyDown}
            className="pl-9"
          />
        </div>
        <Button
          variant="outline"
          size="default"
          onClick={handleSearch}
          className="border-emerald-200 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-400 dark:hover:bg-emerald-900/30"
        >
          Search
        </Button>
      </div>

      {/* Content */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">All Workspaces</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {/* Error state */}
          {error && !loading && (
            <div className="flex flex-col items-center justify-center gap-4 py-16 px-4">
              <div className="flex items-center justify-center h-12 w-12 rounded-full bg-red-100 dark:bg-red-900/30">
                <span className="text-red-600 dark:text-red-400 text-xl">!</span>
              </div>
              <p className="text-sm text-muted-foreground text-center max-w-md">
                {error}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => fetchWorkspaces(undefined, search)}
                className="gap-2"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Retry
              </Button>
            </div>
          )}

          {/* Empty state */}
          {!loading && !error && workspaces.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-4 py-16 px-4">
              <div className="flex items-center justify-center h-12 w-12 rounded-full bg-emerald-100 dark:bg-emerald-900/30">
                <Building2 className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
              </div>
              <div className="text-center">
                <p className="font-medium">No workspaces found</p>
                <p className="text-sm text-muted-foreground mt-1">
                  {search
                    ? `No results for "${search}". Try a different query.`
                    : 'Workspaces will appear here once created.'}
                </p>
              </div>
              {search && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSearchInput('')
                    setSearch('')
                    setPrevCursors([])
                    fetchWorkspaces()
                  }}
                >
                  Clear search
                </Button>
              )}
            </div>
          )}

          {/* Loading state */}
          {loading && (
            <div className="divide-y">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 px-4 py-3">
                  <Skeleton className="h-4 w-36" />
                  <Skeleton className="h-4 w-28 hidden lg:block" />
                  <Skeleton className="h-4 w-8 ml-auto" />
                  <Skeleton className="h-4 w-8 hidden sm:block" />
                  <Skeleton className="h-4 w-8 hidden md:block" />
                  <Skeleton className="h-4 w-20 hidden xl:block" />
                  <Skeleton className="h-4 w-20" />
                </div>
              ))}
            </div>
          )}

          {/* Table */}
          {!loading && !error && workspaces.length > 0 && (
            <>
              <div className="max-h-[600px] overflow-y-auto">
                <Table>
                  <TableHeader className="sticky top-0 bg-card z-10">
                    <TableRow>
                      <TableHead className="pl-4">Name</TableHead>
                      <TableHead className="hidden lg:table-cell">
                        Owner
                      </TableHead>
                      <TableHead className="text-right">
                        <span className="sr-only sm:not-sr-only">Projects</span>
                      </TableHead>
                      <TableHead className="text-right hidden sm:table-cell">
                        Members
                      </TableHead>
                      <TableHead className="text-right hidden md:table-cell">
                        Subs
                      </TableHead>
                      <TableHead className="hidden xl:table-cell">
                        Custom Domain
                      </TableHead>
                      <TableHead className="pr-4 text-right">Created</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {workspaces.map((ws) => (
                      <TableRow key={ws.id}>
                        <TableCell className="pl-4">
                          <div className="flex items-center gap-2.5">
                            <div
                              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold text-white"
                              style={{
                                backgroundColor: ws.accentColor ?? '#059669',
                              }}
                            >
                              {ws.name
                                .slice(0, 2)
                                .toUpperCase()}
                            </div>
                            <div className="min-w-0">
                              <p className="font-medium truncate">
                                {ws.name}
                              </p>
                              <p className="text-xs text-muted-foreground truncate">
                                {ws.slug}
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">
                          <div className="min-w-0">
                            <p className="text-sm truncate">
                              {ws.owner.name ?? '—'}
                            </p>
                            <p className="text-xs text-muted-foreground truncate">
                              {ws.owner.email}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          <span className="sr-only sm:not-sr-only">
                            {ws._count.projects}
                          </span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums hidden sm:table-cell">
                          {ws._count.members}
                        </TableCell>
                        <TableCell className="text-right tabular-nums hidden md:table-cell">
                          {ws._count.subscriptions}
                        </TableCell>
                        <TableCell className="hidden xl:table-cell">
                          {ws.customDomain ? (
                            <Badge
                              variant="outline"
                              className="font-normal text-emerald-700 border-emerald-200 dark:text-emerald-400 dark:border-emerald-800"
                            >
                              {ws.customDomain}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="pr-4 text-right text-muted-foreground text-xs">
                          {relativeTime(ws.createdAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between border-t px-4 py-3">
                <p className="text-sm text-muted-foreground">
                  Showing {rangeStart}
                  {rangeEnd > rangeStart ? `–${rangeEnd}` : ''} of{' '}
                  {total}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!hasPrev}
                    onClick={handlePrev}
                    className="gap-1"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">Previous</span>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!hasNext}
                    onClick={handleNext}
                    className="gap-1"
                  >
                    <span className="hidden sm:inline">Next</span>
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
