"use client"

import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { CreateProjectDialog } from "@/components/app/create-project-dialog"

interface CreateProjectButtonProps {
  workspaceId: string
}

export function CreateProjectButton({ workspaceId }: CreateProjectButtonProps) {
  return (
    <CreateProjectDialog workspaceId={workspaceId}>
      <Button className="gap-1.5">
        <Plus className="h-4 w-4" />
        Create project
      </Button>
    </CreateProjectDialog>
  )
}
