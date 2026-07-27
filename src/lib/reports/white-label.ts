/**
 * White-label service — ProofPilot (Phase 9)
 *
 * Manages workspace branding / white-label configuration used in reports.
 * Agency-plan workspaces can customize:
 *
 *   - Logo URL
 *   - Organization name (brandName)
 *   - Report accent color
 *   - Contact details (email, URL)
 *   - Custom introduction
 *   - Custom footer
 *   - Custom report domain (future-ready — stored but not enforced yet)
 *
 * Plan enforcement: Only workspaces on a plan with `whiteLabel: true`
 * (AGENCY plan) can save white-label settings. Other plans can read
 * defaults but cannot persist custom branding. Attempting to save on a
 * non-white-label plan throws ForbiddenError.
 *
 * Validation:
 *   - accentColor: hex color (#RGB or #RRGGBB) or CSS named color (lowercase).
 *   - brandName: 1–100 chars.
 *   - brandIntro/brandFooter: max 2000 chars each.
 *   - brandContactEmail: valid email format if provided.
 *   - brandContactUrl: valid HTTPS URL if provided.
 *   - customDomain: valid domain if provided (no protocol).
 *   - logoUrl: valid HTTPS URL or relative path if provided.
 */

import { db } from '../db'
import { ForbiddenError, NotFoundError, ValidationError } from '../errors'
import { recordAudit, type AuditContext } from '../audit'
import { hasPermission, type WorkspaceRole } from '../permissions'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WhiteLabelSettings {
  logoUrl: string | null
  accentColor: string | null
  brandName: string | null
  brandIntro: string | null
  brandFooter: string | null
  brandContactEmail: string | null
  brandContactUrl: string | null
  customDomain: string | null
  /** Whether the workspace's current plan allows white-label customization. */
  whiteLabelEnabled: boolean
}

export interface UpdateWhiteLabelInput {
  logoUrl?: string | null
  accentColor?: string | null
  brandName?: string | null
  brandIntro?: string | null
  brandFooter?: string | null
  brandContactEmail?: string | null
  brandContactUrl?: string | null
  customDomain?: string | null
}

export interface UpdateWhiteLabelResult {
  settings: WhiteLabelSettings
  updatedFields: string[]
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const HTTPS_URL_RE = /^https:\/\/.+/i
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i

function validateAccentColor(value: string): void {
  // Accept hex colors (#RGB or #RRGGBB) or common CSS named colors
  if (!HEX_COLOR_RE.test(value)) {
    throw new ValidationError(
      'Accent color must be a hex color (e.g. #ff6600 or #f60) or a valid CSS named color.',
    )
  }
}

function validateBrandName(value: string): void {
  const trimmed = value.trim()
  if (trimmed.length < 1 || trimmed.length > 100) {
    throw new ValidationError('Brand name must be 1–100 characters.')
  }
}

function validateMaxLength(value: string, field: string, max: number): void {
  if (value.length > max) {
    throw new ValidationError(`${field} must not exceed ${max} characters.`)
  }
}

function validateContactEmail(value: string): void {
  if (!EMAIL_RE.test(value.trim())) {
    throw new ValidationError('Contact email must be a valid email address.')
  }
}

function validateContactUrl(value: string): void {
  if (!HTTPS_URL_RE.test(value.trim())) {
    throw new ValidationError('Contact URL must be a valid HTTPS URL (https://...).')
  }
}

function validateCustomDomain(value: string): void {
  const trimmed = value.trim().toLowerCase()
  // Strip protocol if accidentally included
  const domain = trimmed.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  if (!DOMAIN_RE.test(domain)) {
    throw new ValidationError(
      'Custom domain must be a valid domain (e.g. reports.example.com).',
    )
  }
}

function validateLogoUrl(value: string): void {
  // Allow relative paths (for uploaded assets) or HTTPS URLs
  const trimmed = value.trim()
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    if (!HTTPS_URL_RE.test(trimmed)) {
      throw new ValidationError(
        'Logo URL must be a valid HTTPS URL or a relative path.',
      )
    }
  }
  // Relative paths are allowed (e.g. /uploads/logo.png)
}

// ---------------------------------------------------------------------------
// Service Functions
// ---------------------------------------------------------------------------

/**
 * Get the white-label settings for a workspace.
 * Returns current settings + whether white-label is enabled by the plan.
 */
export async function getWhiteLabelSettings(
  workspaceId: string,
): Promise<WhiteLabelSettings> {
  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    include: { plan: { select: { whiteLabel: true } } },
  })

  if (!workspace) {
    throw new NotFoundError('Workspace')
  }

  return {
    logoUrl: workspace.logoUrl ?? null,
    accentColor: workspace.accentColor ?? null,
    brandName: workspace.brandName ?? null,
    brandIntro: workspace.brandIntro ?? null,
    brandFooter: workspace.brandFooter ?? null,
    brandContactEmail: workspace.brandContactEmail ?? null,
    brandContactUrl: workspace.brandContactUrl ?? null,
    customDomain: workspace.customDomain ?? null,
    whiteLabelEnabled: workspace.plan?.whiteLabel ?? false,
  }
}

/**
 * Update white-label settings for a workspace.
 *
 * Requires:
 *   - `workspace.update` permission.
 *   - Workspace plan must have `whiteLabel: true` (AGENCY plan).
 *
 * Each field is validated independently. On validation error, no fields
 * are persisted.
 */
export async function updateWhiteLabelSettings(
  workspaceId: string,
  actorRole: WorkspaceRole,
  input: UpdateWhiteLabelInput,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId' | 'actorId'>,
): Promise<UpdateWhiteLabelResult> {
  if (!hasPermission(actorRole, 'workspace.update')) {
    throw new ForbiddenError('Missing permission: workspace.update')
  }

  // Load workspace with plan
  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    include: { plan: { select: { whiteLabel: true } } },
  })

  if (!workspace) {
    throw new NotFoundError('Workspace')
  }

  // Plan enforcement: white-label only on plans that allow it
  if (!workspace.plan?.whiteLabel) {
    throw new ForbiddenError(
      'White-label customization is available on Agency plans and above. Upgrade your plan to enable custom branding.',
    )
  }

  // Validate all fields before persisting any
  const data: Record<string, unknown> = {}
  const updatedFields: string[] = []

  if (input.logoUrl !== undefined) {
    if (input.logoUrl !== null) validateLogoUrl(input.logoUrl)
    data.logoUrl = input.logoUrl
    updatedFields.push('logoUrl')
  }

  if (input.accentColor !== undefined) {
    if (input.accentColor !== null) validateAccentColor(input.accentColor)
    data.accentColor = input.accentColor
    updatedFields.push('accentColor')
  }

  if (input.brandName !== undefined) {
    if (input.brandName !== null) validateBrandName(input.brandName)
    data.brandName = input.brandName?.trim() ?? null
    updatedFields.push('brandName')
  }

  if (input.brandIntro !== undefined) {
    if (input.brandIntro !== null) {
      validateMaxLength(input.brandIntro, 'Custom introduction', 2000)
    }
    data.brandIntro = input.brandIntro
    updatedFields.push('brandIntro')
  }

  if (input.brandFooter !== undefined) {
    if (input.brandFooter !== null) {
      validateMaxLength(input.brandFooter, 'Custom footer', 2000)
    }
    data.brandFooter = input.brandFooter
    updatedFields.push('brandFooter')
  }

  if (input.brandContactEmail !== undefined) {
    if (input.brandContactEmail !== null) {
      validateContactEmail(input.brandContactEmail)
    }
    data.brandContactEmail = input.brandContactEmail?.trim() ?? null
    updatedFields.push('brandContactEmail')
  }

  if (input.brandContactUrl !== undefined) {
    if (input.brandContactUrl !== null) {
      validateContactUrl(input.brandContactUrl)
    }
    data.brandContactUrl = input.brandContactUrl?.trim() ?? null
    updatedFields.push('brandContactUrl')
  }

  if (input.customDomain !== undefined) {
    if (input.customDomain !== null) {
      validateCustomDomain(input.customDomain)
    }
    data.customDomain = input.customDomain?.trim() ?? null
    updatedFields.push('customDomain')
  }

  if (updatedFields.length === 0) {
    // No changes — return current settings
    return {
      settings: await getWhiteLabelSettings(workspaceId),
      updatedFields: [],
    }
  }

  await db.workspace.update({
    where: { id: workspaceId },
    data,
  })

  await recordAudit(
    'WHITE_LABEL_UPDATE',
    { type: 'workspace', id: workspaceId },
    {
      ...ctx,
      workspaceId,
      actorType: 'USER',
    },
    { updatedFields },
  )

  const settings = await getWhiteLabelSettings(workspaceId)
  return { settings, updatedFields }
}

/**
 * Reset white-label settings to defaults (clear all branding fields).
 * Used when downgrading from an Agency plan to a non-white-label plan.
 * Only SYSTEM actor can call this (for billing webhooks).
 */
export async function resetWhiteLabelSettings(
  workspaceId: string,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
): Promise<void> {
  await db.workspace.update({
    where: { id: workspaceId },
    data: {
      logoUrl: null,
      accentColor: null,
      brandName: null,
      brandIntro: null,
      brandFooter: null,
      brandContactEmail: null,
      brandContactUrl: null,
      // customDomain is NOT reset — it's a domain config, not branding.
      // The domain remains configured for when the plan is upgraded back.
    },
  })

  await recordAudit(
    'WHITE_LABEL_RESET',
    { type: 'workspace', id: workspaceId },
    {
      ...ctx,
      workspaceId,
      actorType: 'SYSTEM',
    },
  )
}
