'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  ShieldCheck,
  ArrowLeft,
  Bug,
  Search,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  SlidersHorizontal,
  X,
  Globe,
  Clock,
  LayoutDashboard,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  FileX,
} from 'lucide-react'

// ─── Types ───────────────────────────────────────────────────────

interface FindingItem {
  id: string
  workspaceId: string
  projectId: string
  runId: string | null
  checkId: string
  category: string
  severity: string
  status: string
  confidence: string
  title: string
  description: string | null
  affectedUrl: string
  normalizedUrl: string
  viewport: string | null
  locale: string | null
  browser: string | null
  tags: string[]
  assignedToId: string | null
  assigneeName: string | null
  firstSeenAt: string
  lastSeenAt: string
  resolvedAt: string | null
  createdAt: string
  updatedAt: string
  occurrenceCount: number
  isSuppressed: boolean
}

interface FindingsResponse {
  items: FindingItem[]
  nextCursor: string | null
  totalApprox: number
}

interface ProjectBrief {
  id: string
  name: string
  workspace: { id: string; name: string; slug: string }
}

// ─── Constants ────────────────────────────────────────────────────

const SEVERITIES = ['BLOCKER', 'CRITICAL', 'MAJOR', 'MINOR', 'INFO'] as const

const STATUSES = [
  'OPEN',
  'ACKNOWLEDGED',
  'IN_PROGRESS',
  'RESOLVED',
  'REOPENED',
  'IGNORED',
  'ACCEPTED_RISK',
  'FALSE_POSITIVE',
] as const

const SORT_OPTIONS = [
  { value: 'lastSeenAt', label: 'Last Seen' },
  { value: 'firstSeenAt', label: 'First Seen' },
  { value: 'severity', label: 'Severity' },
  { value: 'title', label: 'Title' },
] as const

type SortField = (typeof SORT_OPTIONS)[number]['value']
type SortOrder = 'asc' | 'desc'

const PAGE_SIZE = 25

// ─── Helpers ─────────────────────────────────────────────────────

function relativeTime(date: string): string {
  const diff = Date.now() - new Date(date).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function severityColor(severity: string): string {
  switch (severity) {
    case 'BLOCKER':
      return 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300 border-red-200 dark:border-red-800'
    case 'CRITICAL':
      return 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300 border-orange-200 dark:border-orange-800'
    case 'MAJOR':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border-amber-200 dark:border-amber-800'
    case 'MINOR':
      return 'bg-lime-100 text-lime-800 dark:bg-lime-900/40 dark:text-lime-300 border-lime-200 dark:border-lime-800'
    case 'INFO':
      return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 border-gray-200 dark:border-gray-700'
    default:
      return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'OPEN':
      return 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
    case 'ACKNOWLEDGED':
      return 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300'
    case 'IN_PROGRESS':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
    case 'RESOLVED':
      return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
    case 'REOPENED':
      return 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300'
    case 'IGNORED':
      return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
    case 'ACCEPTED_RISK':
      return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
    case 'FALSE_POSITIVE':
      return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
    default:
      return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300'
  }
}

function formatStatus(status: string): string {
  return status
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function truncateUrl(url: string, maxLen = 60): string {
  if (url.length <= maxLen) return url
  return url.slice(0, maxLen - 3) + '...'
}

// ─── Component ────────────────────────────────────────────────────

export default function FindingsTablePage() {
  const params = useParams<{ projectId: string }>()
  const projectId = params.projectId

  const [findings, setFindings] = useState<FindingsResponse | null>(null)
  const [project, setProject] = useState<ProjectBrief | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Filters
  const [selectedSeverities, setSelectedSeverities] = useState<string[]>([])
  const [selectedStatuses, setSelectedStatuses] = useState<string[]>([])
  const [category, setCategory] = useState('')
  const [searchText, setSearchText] = useState('')
  const [searchInput, setSearchInput] = useState('')

  // Sort
  const [sortField, setSortField] = useState<SortField>('lastSeenAt')
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc')

  // Pagination
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [prevCursors, setPrevCursors] = useState<string[]>([])

  // Available categories derived from loaded findings
  const [availableCategories, setAvailableCategories] = useState<string[]>([])

  // ─── Data Fetching ────────────────────────────────────────

  const buildQueryString = useCallback(() => {
    const sp = new URLSearchParams()
    sp.set('limit', PAGE_SIZE.toString())
    if (sortField) sp.set('sort', sortField)
    if (sortOrder) sp.set('order', sortOrder)
    if (cursor) sp.set('cursor', cursor)
    if (selectedSeverities.length > 0) sp.set('severity', selectedSeverities.join(','))
    if (selectedStatuses.length > 0) sp.set('status', selectedStatuses.join(','))
    if (category) sp.set('category', category)
    if (searchText) sp.set('search', searchText)
    return sp.toString()
  }, [sortField, sortOrder, cursor, selectedSeverities, selectedStatuses, category, searchText])

  const loadFindings = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = buildQueryString()
      const res = await fetch(`/api/v1/projects/${projectId}/findings?${qs}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.detail || `Failed to load findings (${res.status})`)
        return
      }
      const data = (await res.json()) as FindingsResponse
      setFindings(data)

      // Derive unique categories
      const cats = new Set<string>()
      data.items.forEach((f) => cats.add(f.category))
      setAvailableCategories((prev) => {
        const merged = new Set([...prev, ...cats])
        return Array.from(merged).sort()
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [projectId, buildQueryString])

  const loadProject = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/projects/${projectId}`)
      if (res.ok) {
        setProject(await res.json())
      }
    } catch {
      // Non-critical; breadcrumb can still work without it
    }
  }, [projectId])

  useEffect(() => {
    void loadProject()
  }, [loadProject])

  useEffect(() => {
    void loadFindings()
  }, [loadFindings])

  // Reset pagination when filters/sort change
  useEffect(() => {
    setCursor(undefined)
    setPrevCursors([])
  }, [selectedSeverities, selectedStatuses, category, searchText, sortField, sortOrder])

  // ─── Handlers ──────────────────────────────────────────────

  const handleSearch = () => {
    setSearchText(searchInput)
  }

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch()
    }
  }

  const toggleSeverity = (sev: string) => {
    setSelectedSeverities((prev) =>
      prev.includes(sev) ? prev.filter((s) => s !== sev) : [...prev, sev],
    )
  }

  const toggleStatus = (status: string) => {
    setSelectedStatuses((prev) =>
      prev.includes(status) ? prev.filter((s) => s !== status) : [...prev, status],
    )
  }

  const toggleSortOrder = () => {
    setSortOrder((prev) => (prev === 'desc' ? 'asc' : 'desc'))
  }

  const goNext = () => {
    if (findings?.nextCursor) {
      setPrevCursors((prev) => [...prev, cursor ?? ''])
      setCursor(findings.nextCursor)
    }
  }

  const goPrev = () => {
    if (prevCursors.length > 0) {
      const newPrev = [...prevCursors]
      const prevCursor = newPrev.pop()!
      setPrevCursors(newPrev)
      setCursor(prevCursor || undefined)
    }
  }

  const clearFilters = () => {
    setSelectedSeverities([])
    setSelectedStatuses([])
    setCategory('')
    setSearchText('')
    setSearchInput('')
  }

  const hasActiveFilters =
    selectedSeverities.length > 0 ||
    selectedStatuses.length > 0 ||
    category !== '' ||
    searchText !== ''

  const activeFilterCount =
    selectedSeverities.length + selectedStatuses.length + (category ? 1 : 0) + (searchText ? 1 : 0)

  // ─── Loading Skeleton ───────────────────────────────────────

  if (loading && !findings) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <PageHeader projectName={project?.name} />
        <main className="flex-1 mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
          <div className="animate-pulse space-y-6">
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-96 w-full rounded-lg" />
          </div>
        </main>
      </div>
    )
  }

  // ─── Error State ───────────────────────────────────────────

  if (error && !findings) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <PageHeader projectName={project?.name} />
        <main className="flex-1 mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
          <Card>
            <CardHeader>
              <CardTitle>Failed to load findings</CardTitle>
              <CardDescription>{error}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={() => void loadFindings()} variant="outline">
                Retry
              </Button>
            </CardContent>
          </Card>
        </main>
      </div>
    )
  }

  // ─── Main Render ────────────────────────────────────────────

  const canGoPrev = prevCursors.length > 0
  const canGoNext = !!findings?.nextCursor
  const totalItems = findings?.totalApprox ?? 0

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <PageHeader projectName={project?.name} />

      <main className="flex-1 mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-6">
          <Link href="/app" className="hover:text-foreground transition-colors">
            Dashboard
          </Link>
          <ChevronRight className="h-3.5 w-3.5" />
          {project && (
            <>
              <Link href={`/app/projects/${projectId}`} className="hover:text-foreground transition-colors">
                {project.name}
              </Link>
              <ChevronRight className="h-3.5 w-3.5" />
            </>
          )}
          <span className="text-foreground font-medium">Findings</span>
        </div>

        {/* Page Title */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" asChild>
              <Link href={`/app/projects/${projectId}`}>
                <ArrowLeft className="h-4 w-4" />
              </Link>
            </Button>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Findings</h1>
            <Badge variant="secondary" className="text-xs">
              {totalItems} {totalItems === 1 ? 'finding' : 'findings'}
            </Badge>
          </div>
        </div>

        {/* Filters Bar */}
        <Card className="mb-6">
          <CardContent className="p-4">
            <div className="flex flex-col lg:flex-row gap-4">
              {/* Search Input */}
              <div className="relative flex-1 max-w-sm">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search findings..."
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  className="pl-9 pr-8"
                />
                {searchInput && (
                  <button
                    onClick={() => {
                      setSearchInput('')
                      setSearchText('')
                    }}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              {/* Severity Filter */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="shrink-0">
                    <SlidersHorizontal className="h-4 w-4 mr-1.5" />
                    Severity
                    {selectedSeverities.length > 0 && (
                      <Badge variant="secondary" className="ml-1.5 h-5 w-5 rounded-full p-0 text-xs flex items-center justify-center">
                        {selectedSeverities.length}
                      </Badge>
                    )}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-48">
                  <DropdownMenuLabel>Filter by Severity</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {SEVERITIES.map((sev) => (
                    <DropdownMenuItem
                      key={sev}
                      onClick={() => toggleSeverity(sev)}
                      className="flex items-center justify-between"
                    >
                      <div className="flex items-center gap-2">
                        <div className={`w-2.5 h-2.5 rounded-full ${sevDotColor(sev)}`} />
                        {sev}
                      </div>
                      {selectedSeverities.includes(sev) && (
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Status Filter */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="shrink-0">
                    Status
                    {selectedStatuses.length > 0 && (
                      <Badge variant="secondary" className="ml-1.5 h-5 w-5 rounded-full p-0 text-xs flex items-center justify-center">
                        {selectedStatuses.length}
                      </Badge>
                    )}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-52">
                  <DropdownMenuLabel>Filter by Status</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {STATUSES.map((status) => (
                    <DropdownMenuItem
                      key={status}
                      onClick={() => toggleStatus(status)}
                      className="flex items-center justify-between"
                    >
                      <span>{formatStatus(status)}</span>
                      {selectedStatuses.includes(status) && (
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Category Filter */}
              <Select value={category} onValueChange={(v) => setCategory(v === '__all__' ? '' : v)}>
                <SelectTrigger size="sm" className="w-[160px] shrink-0">
                  <SelectValue placeholder="Category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All Categories</SelectItem>
                  {availableCategories.map((cat) => (
                    <SelectItem key={cat} value={cat}>
                      {cat.replace(/_/g, ' ')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Sort */}
              <div className="flex items-center gap-1">
                <Select
                  value={sortField}
                  onValueChange={(v) => setSortField(v as SortField)}
                >
                  <SelectTrigger size="sm" className="w-[130px] shrink-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SORT_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={toggleSortOrder}>
                  {sortOrder === 'desc' ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronUp className="h-4 w-4" />
                  )}
                </Button>
              </div>

              {/* Clear Filters */}
              {hasActiveFilters && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearFilters}
                  className="shrink-0 text-muted-foreground"
                >
                  <X className="h-3.5 w-3.5 mr-1" />
                  Clear ({activeFilterCount})
                </Button>
              )}
            </div>

            {/* Active Filter Badges */}
            {hasActiveFilters && (
              <div className="flex flex-wrap gap-1.5 mt-3">
                {selectedSeverities.map((sev) => (
                  <Badge
                    key={sev}
                    variant="outline"
                    className={`text-xs cursor-pointer hover:opacity-70 ${severityColor(sev)}`}
                    onClick={() => toggleSeverity(sev)}
                  >
                    {sev}
                    <X className="h-2.5 w-2.5 ml-1" />
                  </Badge>
                ))}
                {selectedStatuses.map((status) => (
                  <Badge
                    key={status}
                    variant="outline"
                    className={`text-xs cursor-pointer hover:opacity-70 ${statusColor(status)}`}
                    onClick={() => toggleStatus(status)}
                  >
                    {formatStatus(status)}
                    <X className="h-2.5 w-2.5 ml-1" />
                  </Badge>
                ))}
                {category && (
                  <Badge
                    variant="outline"
                    className="text-xs cursor-pointer hover:opacity-70"
                    onClick={() => setCategory('')}
                  >
                    {category.replace(/_/g, ' ')}
                    <X className="h-2.5 w-2.5 ml-1" />
                  </Badge>
                )}
                {searchText && (
                  <Badge
                    variant="outline"
                    className="text-xs cursor-pointer hover:opacity-70"
                    onClick={() => {
                      setSearchText('')
                      setSearchInput('')
                    }}
                  >
                    &ldquo;{searchText}&rdquo;
                    <X className="h-2.5 w-2.5 ml-1" />
                  </Badge>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Findings Table */}
        <Card>
          {loading ? (
            <CardContent className="p-6">
              <div className="flex items-center justify-center gap-2 text-muted-foreground text-sm">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading findings...
              </div>
            </CardContent>
          ) : !findings || findings.items.length === 0 ? (
            <CardContent className="py-16">
              <div className="flex flex-col items-center text-center">
                <FileX className="h-12 w-12 text-muted-foreground/40 mb-4" />
                <h3 className="text-lg font-medium mb-1">
                  {hasActiveFilters ? 'No matching findings' : 'No findings yet'}
                </h3>
                <p className="text-sm text-muted-foreground mb-4">
                  {hasActiveFilters
                    ? 'Try adjusting your filters or search terms.'
                    : 'Findings will appear here once a scan run has completed analysis.'}
                </p>
                {hasActiveFilters && (
                  <Button variant="outline" size="sm" onClick={clearFilters}>
                    Clear All Filters
                  </Button>
                )}
              </div>
            </CardContent>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[100px]">Severity</TableHead>
                    <TableHead className="min-w-[200px]">Title</TableHead>
                    <TableHead className="hidden md:table-cell w-[140px]">Category</TableHead>
                    <TableHead className="hidden sm:table-cell w-[130px]">Status</TableHead>
                    <TableHead className="hidden lg:table-cell">URL</TableHead>
                    <TableHead className="hidden lg:table-cell w-[90px]">First Seen</TableHead>
                    <TableHead className="w-[90px]">Last Seen</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {findings.items.map((finding) => (
                    <TableRow key={finding.id} className="cursor-pointer">
                      <TableCell>
                        <Badge variant="outline" className={`text-xs font-medium ${severityColor(finding.severity)}`}>
                          {finding.severity}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate max-w-xs lg:max-w-md">
                            {finding.title}
                          </p>
                          <div className="flex items-center gap-2 mt-0.5 md:hidden">
                            <Badge variant="outline" className={`text-[10px] ${severityColor(finding.severity)}`}>
                              {finding.severity}
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              {finding.category.replace(/_/g, ' ')}
                            </span>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <span className="text-sm text-muted-foreground">
                          {finding.category.replace(/_/g, ' ')}
                        </span>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <Badge variant="outline" className={`text-xs ${statusColor(finding.status)}`}>
                          {formatStatus(finding.status)}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        <span className="text-xs font-mono text-muted-foreground block truncate max-w-[250px]" title={finding.affectedUrl}>
                          {truncateUrl(finding.affectedUrl)}
                        </span>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {relativeTime(finding.firstSeenAt)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {relativeTime(finding.lastSeenAt)}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {/* Pagination */}
              <div className="flex items-center justify-between px-4 py-3 border-t">
                <p className="text-sm text-muted-foreground">
                  Showing {findings.items.length} of {totalItems} findings
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canGoPrev}
                    onClick={goPrev}
                  >
                    <ChevronLeft className="h-4 w-4 mr-1" />
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canGoNext}
                    onClick={goNext}
                  >
                    Next
                    <ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </Card>
      </main>

      {/* Footer */}
      <footer className="border-t mt-auto">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-4 text-sm text-muted-foreground">
          &copy; {new Date().getFullYear()} ProofPilot. Automated QA, not penetration testing.
        </div>
      </footer>
    </div>
  )
}

// ─── Sub-Components ─────────────────────────────────────────────

function PageHeader({ projectName }: { projectName?: string }) {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur-sm">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-14 items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/" className="flex items-center gap-2 font-semibold">
              <ShieldCheck className="h-5 w-5 text-primary" />
              <span>ProofPilot</span>
            </Link>
            <nav className="hidden sm:flex items-center gap-1">
              <Link
                href="/app"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-muted-foreground hover:bg-muted text-sm"
              >
                <LayoutDashboard className="h-3.5 w-3.5" />
                Dashboard
              </Link>
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary/10 text-primary text-sm font-medium">
                <Bug className="h-3.5 w-3.5" />
                Findings
              </div>
            </nav>
          </div>
        </div>
      </div>
    </header>
  )
}

function sevDotColor(sev: string): string {
  switch (sev) {
    case 'BLOCKER':
      return 'bg-red-500'
    case 'CRITICAL':
      return 'bg-orange-500'
    case 'MAJOR':
      return 'bg-amber-500'
    case 'MINOR':
      return 'bg-lime-500'
    case 'INFO':
      return 'bg-gray-400'
    default:
      return 'bg-gray-400'
  }
}
