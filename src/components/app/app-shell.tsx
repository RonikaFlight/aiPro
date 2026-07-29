"use client"

import { useRouter } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import {
  ShieldCheck,
  LayoutDashboard,
  FolderSearch,
  Bug,
  FileBarChart,
  LogOut,
  Plus,
} from "lucide-react"
import { CreateWorkspaceDialog } from "@/components/app/create-workspace-dialog"

interface AppHeaderProps {
  email: string
  userName: string
  hasWorkspaces: boolean
}

export function AppHeader({ email, userName, hasWorkspaces }: AppHeaderProps) {
  const router = useRouter()

  const handleSignOut = async () => {
    try {
      const csrfRes = await fetch("/api/v1/csrf")
      const csrfData = await csrfRes.json()
      await fetch("/api/v1/auth/logout", {
        method: "POST",
        headers: { "x-csrf-token": csrfData.csrfToken },
      })
    } catch {
      // ignore errors and redirect anyway
    }
    window.location.href = "/login"
  }

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
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary/10 text-primary text-sm font-medium"
              >
                <LayoutDashboard className="h-3.5 w-3.5" />
                Dashboard
              </Link>
              <Link
                href="/app"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-muted-foreground hover:bg-muted text-sm"
              >
                <FolderSearch className="h-3.5 w-3.5" />
                Projects
              </Link>
              <Link
                href="/app"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-muted-foreground hover:bg-muted text-sm"
              >
                <Bug className="h-3.5 w-3.5" />
                Findings
              </Link>
              <Link
                href="/app"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-muted-foreground hover:bg-muted text-sm"
              >
                <FileBarChart className="h-3.5 w-3.5" />
                Reports
              </Link>
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right hidden sm:block">
              <div className="text-sm font-medium">{email}</div>
            </div>
            <div className="h-8 w-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-medium">
              {userName.charAt(0).toUpperCase()}
            </div>
            <button
              type="button"
              onClick={handleSignOut}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </div>
    </header>
  )
}

interface WorkspaceSectionProps {
  hasWorkspaces: boolean
}

export function WorkspaceSection({ hasWorkspaces }: WorkspaceSectionProps) {
  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">Workspaces</h2>
        <CreateWorkspaceDialog>
          <Button size="sm" className="gap-1.5">
            <Plus className="h-3.5 w-3.5" />
            New workspace
          </Button>
        </CreateWorkspaceDialog>
      </div>

      {!hasWorkspaces && (
        <div className="border rounded-lg p-8 text-center">
          <div className="mx-auto w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-4">
            <Plus className="h-6 w-6 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-medium mb-1">No workspaces yet</h3>
          <p className="text-sm text-muted-foreground mb-4">
            Create your first workspace to start scanning.
          </p>
          <CreateWorkspaceDialog>
            <Button className="gap-1.5">
              <Plus className="h-4 w-4" />
              Create workspace
            </Button>
          </CreateWorkspaceDialog>
        </div>
      )}
    </section>
  )
}
