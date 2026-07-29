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
import { Textarea } from "@/components/ui/textarea"
import { Loader2 } from "lucide-react"
import { useToast } from "@/hooks/use-toast"

interface CreateProjectDialogProps {
  workspaceId: string
  children: React.ReactNode
}

export function CreateProjectDialog({ workspaceId, children }: CreateProjectDialogProps) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [targetUrl, setTargetUrl] = useState("")
  const [description, setDescription] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const router = useRouter()
  const { toast } = useToast()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")

    if (!name.trim()) {
      setError("Project name is required")
      return
    }
    if (!targetUrl.trim()) {
      setError("Target URL is required")
      return
    }

    setLoading(true)
    try {
      const csrfRes = await fetch("/api/v1/csrf")
      const csrfData = await csrfRes.json()
      const csrfToken = csrfData.csrfToken

      const res = await fetch(`/api/v1/workspaces/${workspaceId}/projects`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify({
          name: name.trim(),
          productionUrl: targetUrl.trim(),
          description: description.trim() || undefined,
        }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.detail || data.title || `Error ${res.status}`)
        return
      }

      const project = await res.json()
      toast({
        title: "Project created",
        description: `"${project.name}" is ready for scanning.`,
      })
      setOpen(false)
      setName("")
      setTargetUrl("")
      setDescription("")
      router.push(`/app/projects/${project.id}`)
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
      <DialogContent className="sm:max-w-[475px]">
        <DialogHeader>
          <DialogTitle>Create Project</DialogTitle>
          <DialogDescription>
            Add a new web application to your workspace for automated QA scanning.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="proj-name">Project Name</Label>
              <Input
                id="proj-name"
                placeholder="e.g., My Landing Page"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="proj-url">Target URL</Label>
              <Input
                id="proj-url"
                type="url"
                placeholder="https://example.com"
                value={targetUrl}
                onChange={(e) => setTargetUrl(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                The URL to scan for quality issues.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="proj-desc">Description (optional)</Label>
              <Textarea
                id="proj-desc"
                placeholder="Brief description of the project..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
              />
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
