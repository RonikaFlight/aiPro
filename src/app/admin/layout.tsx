'use client'

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import {
  LayoutDashboard,
  Users,
  Building2,
  PlayCircle,
  Briefcase,
  CreditCard,
  ShieldAlert,
  HeartPulse,
  Flag,
  ChevronLeft,
  Menu,
  Moon,
  Sun,
  LogOut,
} from 'lucide-react'
import { useTheme } from 'next-themes'

const navItems = [
  { href: '/admin', label: 'Overview', icon: LayoutDashboard },
  { href: '/admin/users', label: 'Users', icon: Users },
  { href: '/admin/workspaces', label: 'Workspaces', icon: Building2 },
  { href: '/admin/runs', label: 'Scan Runs', icon: PlayCircle },
  { href: '/admin/jobs', label: 'Queue Jobs', icon: Briefcase },
  { href: '/admin/subscriptions', label: 'Subscriptions', icon: CreditCard },
  { href: '/admin/security-events', label: 'Security', icon: ShieldAlert },
  { href: '/admin/system-health', label: 'System Health', icon: HeartPulse },
  { href: '/admin/feature-flags', label: 'Feature Flags', icon: Flag },
]

interface SidebarProps {
  pathname: string
  collapsed: boolean
  theme: string | undefined
  onToggleCollapse: () => void
  onToggleTheme: () => void
}

function AdminSidebar({
  pathname,
  collapsed,
  theme,
  onToggleCollapse,
  onToggleTheme,
}: SidebarProps) {
  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-4">
        <ShieldAlert className="h-6 w-6 text-emerald-600 shrink-0" />
        {!collapsed && (
          <div className="min-w-0">
            <h1 className="text-sm font-bold truncate">Admin Panel</h1>
            <p className="text-xs text-muted-foreground truncate">ProofPilot</p>
          </div>
        )}
      </div>

      <Separator />

      {/* Navigation */}
      <ScrollArea className="flex-1 px-2 py-3">
        <nav className="flex flex-col gap-1">
          {navItems.map((item) => {
            const isActive =
              item.href === '/admin'
                ? pathname === '/admin'
                : pathname.startsWith(item.href)
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {!collapsed && <span className="truncate">{item.label}</span>}
              </Link>
            )
          })}
        </nav>
      </ScrollArea>

      <Separator />

      {/* Footer */}
      <div className="flex items-center gap-2 px-4 py-3">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={onToggleCollapse}
        >
          <ChevronLeft className={`h-4 w-4 transition-transform ${collapsed ? 'rotate-180' : ''}`} />
        </Button>
        {!collapsed && (
          <>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={onToggleTheme}
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
            <Link href="/app" className="ml-auto">
              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
                <LogOut className="h-4 w-4" />
              </Button>
            </Link>
          </>
        )}
      </div>
    </div>
  )
}

export default function AdminLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const { theme, setTheme } = useTheme()
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [authorized, setAuthorized] = useState<boolean | null>(null)

  useEffect(() => {
    fetch('/api/v1/admin/stats')
      .then((res) => {
        setAuthorized(res.ok)
        if (!res.ok) window.location.href = '/app'
      })
      .catch(() => {
        setAuthorized(false)
        window.location.href = '/app'
      })
  }, [])

  const prevPathname = useState(pathname)
  if (prevPathname[0] !== pathname) {
    prevPathname[1](pathname)
    setMobileOpen(false)
  }

  if (authorized === null) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Skeleton className="h-8 w-48" />
      </div>
    )
  }

  const sidebarProps: SidebarProps = {
    pathname,
    collapsed,
    theme,
    onToggleCollapse: () => setCollapsed((c) => !c),
    onToggleTheme: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
  }

  return (
    <div className="flex h-screen bg-background">
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Desktop sidebar */}
      <aside
        className={`hidden lg:flex flex-col border-r bg-card transition-all duration-200 ${
          collapsed ? 'w-16' : 'w-56'
        }`}
      >
        <AdminSidebar {...sidebarProps} />
      </aside>

      {/* Mobile sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-64 border-r bg-card transition-transform lg:hidden ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <AdminSidebar {...sidebarProps} collapsed={false} />
      </aside>

      {/* Main content */}
      <main className="flex flex-1 flex-col min-w-0">
        {/* Top bar (mobile) */}
        <header className="flex items-center gap-3 border-b px-4 py-3 lg:hidden">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setMobileOpen(true)}
          >
            <Menu className="h-4 w-4" />
          </Button>
          <ShieldAlert className="h-5 w-5 text-emerald-600" />
          <span className="text-sm font-semibold">Admin</span>
        </header>

        <div className="flex-1 overflow-auto">
          {children}
        </div>

        {/* Footer */}
        <footer className="border-t px-4 py-3 text-center text-xs text-muted-foreground">
          ProofPilot Admin Panel &mdash; Internal Use Only
        </footer>
      </main>
    </div>
  )
}
