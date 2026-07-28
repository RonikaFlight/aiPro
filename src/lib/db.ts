/**
 * Database client + workspace-scoped helpers — ProofPilot
 *
 * Prisma client is a singleton in dev. Every workspace-owned query MUST
 * go through `db` and include `workspaceId` in its `where` clause.
 *
 * For sensitive operations that the ORM cannot safely express, use
 * `db.$executeRaw` with parameterized queries (never string concatenation).
 *
 * See DATABASE_DESIGN.md §"Tenant isolation".
 */
import { PrismaClient } from '@prisma/client'
import { logger } from './logger'
import { NotFoundError } from './errors'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development'
      ? ['warn', 'error']
      : ['error'],
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = db
}

/**
 * Workspace-scoped access. Always include `workspaceId` in queries.
 *
 * Usage:
 *   const projects = await db.project.findMany({
 *     where: workspaceWhere(workspaceId, { status: 'ACTIVE' }),
 *   })
 */
export function workspaceWhere<T extends Record<string, unknown>>(
  workspaceId: string,
  extra: T = {} as T,
): { workspaceId: string } & T {
  return { workspaceId, ...extra }
}

/**
 * Verify a resource belongs to the given workspace. Throws NotFoundError
 * if not (do not leak existence).
 */
export async function assertWorkspaceOwned(
  model: 'project' | 'workspace' | 'scanRun' | 'finding' | 'report' | 'artifact' | 'journey',
  id: string,
  workspaceId: string,
): Promise<boolean> {
  const record = await (db[model] as { findUnique: (args: { where: { id: string }; select: { workspaceId: boolean } }) => Promise<{ workspaceId: string } | null> }).findUnique({
    where: { id },
    select: { workspaceId: true },
  })
  if (!record || record.workspaceId !== workspaceId) {
    throw new NotFoundError('Resource')
  }
  return true
}

export async function disconnectDb(): Promise<void> {
  try {
    await db.$disconnect()
  } catch (err) {
    logger.error('Failed to disconnect database', { error: String(err) })
  }
}
