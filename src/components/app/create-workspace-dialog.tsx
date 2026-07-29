"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2 } from "lucide-react"
import { useToast } from "@/hooks/use-toast"

interface CreateWorkspaceDialogProps {
  children: React.ReactNode
}

export function CreateWorkspaceDialog({ children }: CreateWorkspaceDialogProps) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [slug, setSlug] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const router = useRouter()
  const { toast } = useToast()

  const handleSlugChange = (value: string) => {
    const slugVal = value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")
    setSlug(slugVal)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")

    if (!name.trim()) {
      setError("Name is required")
      return
    }
    if (!slug.trim()) {
      setError("Slug is required")
      return
    }

    setLoading(true)
    try {
      const csrfRes = await fetch("/api/v1/csrf")
      const csrfData = await csrfRes.json()
      const csrfToken = csrfData.csrfToken

      const res = await fetch("/api/v1/workspaces", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify({ name: name.trim(), slug: slug.trim() }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.detail || data.title || `Error ${res.status}`)
        return
      }

      const workspace = await res.json()
      toast({
        title: "Workspace created",
        description: `"${workspace.name}" is ready to use.`,
      })
      setOpen(false)
      setName("")
      setSlug("")
      router.push(`/app/workspaces/${workspace.id}`)
      router.refresh()
    } catch {
      setError("Something went wrong. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Create Workspace</DialogTitle>
          <DialogDescription>
            A workspace groups your projects together. Each team member belongs to one or more workspaces.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="ws-name">Name</Label>
              <Input
                id="ws-name"
                placeholder="e.g., Acme Corp"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ws-slug">Slug</Label>
              <Input
                id="ws-slug"
                placeholder="e.g., acme-corp"
                value={slug}
                onChange={(e) => handleSlugChange(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Unique identifier used in URLs.
              </p>
            </div>
            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
