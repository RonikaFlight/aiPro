/**
 * Artifact storage service — ProofPilot
 *
 * Stores scanner artifacts (screenshots, traces, videos, HARs, console logs,
 * network logs, PDFs) on the local filesystem under `download/artifacts/`.
 *
 * In production this should be swapped for S3/MinIO — the interface is
 * storage-backend-agnostic.
 *
 * Security:
 *   - Artifacts are private — never served directly from the filesystem.
 *   - Access is via signed, time-limited URLs that verify an HMAC signature.
 *   - MIME is sniffed from the buffer (not trusted from upload) and restricted to an allowlist.
 *   - SHA-256 hash is recorded for integrity / dedup.
 *   - Size capped at WORKER_MAX_RESPONSE_SIZE_BYTES (5 MB default).
 *   - Retention enforced by a maintenance job.
 *
 * See SECURITY_MODEL.md §"Artifact storage" and THREAT_MODEL.md T15.
 */
import { promises as fs } from 'fs'
import path from 'path'
import { createHash, createHmac } from 'crypto'
import { db } from './db'
import { env } from './env'
import { logger } from './logger'
import { ForbiddenError, NotFoundError, ValidationError } from './errors'
import { randomHex, hmacSha256 } from './crypto'

export type ArtifactType =
  | 'SCREENSHOT'
  | 'TRACE'
  | 'VIDEO'
  | 'HAR'
  | 'CONSOLE_LOG'
  | 'NETWORK_LOG'
  | 'ERROR_LOG'
  | 'REPORT_PDF'
  | 'DIFF_IMAGE'
  | 'CRAWL_GRAPH'
  | 'OTHER'

const ALLOWED_MIME: Record<ArtifactType, string[]> = {
  SCREENSHOT: ['image/png', 'image/jpeg', 'image/webp'],
  TRACE: ['application/json', 'application/zip'],
  VIDEO: ['video/webm', 'video/mp4'],
  HAR: ['application/json'],
  CONSOLE_LOG: ['application/json', 'text/plain'],
  NETWORK_LOG: ['application/json', 'text/plain'],
  ERROR_LOG: ['application/json', 'text/plain'],
  REPORT_PDF: ['application/pdf'],
  DIFF_IMAGE: ['image/png', 'image/jpeg', 'image/webp'],
  CRAWL_GRAPH: ['application/json'],
  OTHER: ['application/json', 'text/plain', 'image/png', 'image/jpeg'],
}

const MAX_SIZE = env.WORKER_MAX_RESPONSE_SIZE_BYTES
const ARTIFACT_ROOT = path.resolve(process.cwd(), 'download', 'artifacts')

/** Ensure the artifact directory exists. */
async function ensureRoot(): Promise<void> {
  await fs.mkdir(ARTIFACT_ROOT, { recursive: true })
}

/** Detect MIME type from a buffer using magic-byte sniffing. */
function sniffMime(buffer: Buffer, fallback: string): string {
  if (buffer.length >= 8) {
    // PNG
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
    // JPEG
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
    // WebP (RIFF....WEBP)
    if (
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
    ) return 'image/webp'
    // PDF
    if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return 'application/pdf'
    // ZIP (used by Playwright traces)
    if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) return 'application/zip'
    // WebM
    if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return 'video/webm'
    // MP4
    if (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) return 'video/mp4'
  }
  // JSON?
  const text = buffer.slice(0, Math.min(buffer.length, 64)).toString('utf8').trim()
  if (text.startsWith('{') || text.startsWith('[')) return 'application/json'
  if (text.startsWith('<') || /^[a-zA-Z0-9_\-=./]+:/.test(text)) return 'text/plain'
  return fallback
}

export interface StoreArtifactInput {
  workspaceId: string
  projectId: string
  runId?: string
  type: ArtifactType
  /** Filename hint (used for extension; sanitized). */
  filename: string
  /** Raw artifact bytes. */
  buffer: Buffer
  /** MIME declared by the producer — verified against the allowlist + sniffed. */
  declaredMime?: string
  /** Retention days (overrides default). */
  retentionDays?: number
}

export interface StoredArtifact {
  id: string
  type: ArtifactType
  storageKey: string
  sizeBytes: number
  hashSha256: string
  mimeType: string
  signedUrl: string
  expiresAt: string
  retentionExpiresAt: string | null
  createdAt: string
}

/**
 * Persist an artifact to disk + record it in the DB.
 * Returns metadata + a short-lived signed URL for downloading.
 */
export async function storeArtifact(input: StoreArtifactInput): Promise<StoredArtifact> {
  if (!input.buffer || input.buffer.length === 0) {
    throw new ValidationError('Artifact buffer is empty')
  }
  if (input.buffer.length > MAX_SIZE) {
    throw new ValidationError(`Artifact exceeds max size ${MAX_SIZE} bytes (got ${input.buffer.length})`)
  }

  await ensureRoot()

  // Compute hash + MIME
  const hashSha256 = createHash('sha256').update(input.buffer).digest('hex')
  const sniffedMime = sniffMime(input.buffer, input.declaredMime ?? 'application/octet-stream')
  const allowed = ALLOWED_MIME[input.type] ?? ALLOWED_MIME.OTHER
  const mimeType = allowed.includes(sniffedMime) ? sniffedMime : (allowed[0] ?? 'application/octet-stream')

  // Build a safe storage key: <workspaceId>/<runId-or-projects>/<artifactId>.<ext>
  const safeFilename = input.filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)
  const artifactId = `art_${randomHex(12)}`
  const ext = path.extname(safeFilename) || mimeToExt(mimeType)
  const subdir = input.runId ?? `proj_${input.projectId}`
  const storageKey = `${input.workspaceId}/${subdir}/${artifactId}${ext}`
  const fullPath = path.join(ARTIFACT_ROOT, storageKey)

  // Prevent path traversal: ensure final resolved path is inside ARTIFACT_ROOT
  const resolvedFull = path.resolve(fullPath)
  if (!resolvedFull.startsWith(ARTIFACT_ROOT + path.sep) && resolvedFull !== ARTIFACT_ROOT) {
    throw new ForbiddenError('Invalid artifact storage path')
  }
  await fs.mkdir(path.dirname(resolvedFull), { recursive: true })
  await fs.writeFile(resolvedFull, input.buffer)

  // Retention
  const retentionDays = input.retentionDays ?? env.RETENTION_ARTIFACT_DAYS
  const retentionExpiresAt = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000)

  // DB record
  const artifact = await db.artifact.create({
    data: {
      id: artifactId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      runId: input.runId ?? null,
      type: input.type,
      storageKey,
      sizeBytes: input.buffer.length,
      hashSha256,
      mimeType,
      retentionExpiresAt,
    },
  })

  // Signed URL (15-minute validity by default)
  const signed = signArtifactUrl(artifact.id, 15 * 60)

  logger.debug('Artifact stored', {
    artifactId: artifact.id,
    type: input.type,
    sizeBytes: input.buffer.length,
    mimeType,
    storageKey,
  })

  return {
    id: artifact.id,
    type: input.type,
    storageKey,
    sizeBytes: input.buffer.length,
    hashSha256,
    mimeType,
    signedUrl: signed.url,
    expiresAt: signed.expiresAt.toISOString(),
    retentionExpiresAt: artifact.retentionExpiresAt?.toISOString() ?? null,
    createdAt: artifact.createdAt.toISOString(),
  }
}

/** Read an artifact's bytes from disk. */
export async function readArtifactBuffer(storageKey: string): Promise<Buffer> {
  const resolved = path.resolve(ARTIFACT_ROOT, storageKey)
  if (!resolved.startsWith(ARTIFACT_ROOT + path.sep)) {
    throw new ForbiddenError('Invalid artifact path')
  }
  try {
    return await fs.readFile(resolved)
  } catch {
    throw new NotFoundError('Artifact file')
  }
}

export interface SignedArtifactUrl {
  url: string
  expiresAt: Date
}

/**
 * Build a signed URL for downloading an artifact.
 * Format: /api/v1/artifacts/<id>?exp=<epoch>&sig=<hex>
 * Signature = HMAC-SHA256(CSRF_SECRET, "<id>:<exp>").
 */
export function signArtifactUrl(artifactId: string, ttlSeconds: number): SignedArtifactUrl {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds
  const payload = `${artifactId}:${exp}`
  const sig = hmacSha256(env.CSRF_SECRET, payload)
  return {
    url: `/api/v1/artifacts/${artifactId}?exp=${exp}&sig=${sig}`,
    expiresAt: new Date(exp * 1000),
  }
}

/** Verify a signed URL's signature + expiry. Returns true if valid. */
export function verifyArtifactSignature(artifactId: string, exp: number, sig: string): boolean {
  if (!Number.isInteger(exp) || exp < Math.floor(Date.now() / 1000)) {
    return false
  }
  const expected = hmacSha256(env.CSRF_SECRET, `${artifactId}:${exp}`)
  // Constant-time-ish comparison
  if (expected.length !== sig.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i)
  }
  return diff === 0
}

/** Get an artifact record (workspace-scoped). */
export async function getArtifact(artifactId: string, workspaceId: string) {
  const artifact = await db.artifact.findUnique({ where: { id: artifactId } })
  if (!artifact || artifact.workspaceId !== workspaceId) {
    throw new NotFoundError('Artifact')
  }
  return artifact
}

function mimeToExt(mime: string): string {
  switch (mime) {
    case 'image/png': return '.png'
    case 'image/jpeg': return '.jpg'
    case 'image/webp': return '.webp'
    case 'application/pdf': return '.pdf'
    case 'application/zip': return '.zip'
    case 'video/webm': return '.webm'
    case 'video/mp4': return '.mp4'
    case 'application/json': return '.json'
    case 'text/plain': return '.txt'
    default: return '.bin'
  }
}

/**
 * Delete artifacts whose retention has expired.
 * Called by the maintenance queue.
 */
export async function cleanupExpiredArtifacts(): Promise<{ deleted: number }> {
  const expired = await db.artifact.findMany({
    where: { retentionExpiresAt: { lt: new Date() } },
    select: { id: true, storageKey: true },
    take: 100,
  })
  for (const a of expired) {
    try {
      const resolved = path.resolve(ARTIFACT_ROOT, a.storageKey)
      if (resolved.startsWith(ARTIFACT_ROOT + path.sep)) {
        await fs.unlink(resolved).catch(() => {})
      }
    } catch (err) {
      logger.warn('Failed to delete artifact file', { storageKey: a.storageKey, error: String(err) })
    }
    await db.artifact.delete({ where: { id: a.id } }).catch(() => {})
  }
  return { deleted: expired.length }
}
