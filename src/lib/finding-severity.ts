/**
 * Finding severity & business impact — ProofPilot (Phase 6)
 *
 * Severity is **deterministic first**. The analyzers assign severity using the
 * rules in this module. AI may later *explain* or *re-categorize business
 * impact*, but it can never silently override the deterministic severity
 * without recording an explicit `severity_overridden` audit entry
 * (handled in `findings-service.ts`).
 *
 * See:
 *   - SECURITY_MODEL.md §"Findings"
 *   - IMPLEMENTATION_CHECKLIST.md Phase 6
 */
import { ValidationError } from './errors'

// ---------------- Severity ----------------

export type FindingSeverity = 'BLOCKER' | 'CRITICAL' | 'MAJOR' | 'MINOR' | 'INFO'

export const SEVERITIES: readonly FindingSeverity[] = [
  'BLOCKER',
  'CRITICAL',
  'MAJOR',
  'MINOR',
  'INFO',
] as const

/**
 * Numeric weight per severity (higher = worse).
 * Used by the quality-score service. INFO findings do not reduce the score.
 */
export const SEVERITY_WEIGHTS: Record<FindingSeverity, number> = {
  BLOCKER: 25,
  CRITICAL: 12,
  MAJOR: 5,
  MINOR: 2,
  INFO: 0,
}

/** Rank for ordering (descending severity). BLOCKER = 5, INFO = 1. */
export const SEVERITY_RANK: Record<FindingSeverity, number> = {
  BLOCKER: 5,
  CRITICAL: 4,
  MAJOR: 3,
  MINOR: 2,
  INFO: 1,
}

/** Maximum score contribution per severity (caps each finding's penalty). */
export const SEVERITY_MAX_PENALTY: Record<FindingSeverity, number> = {
  BLOCKER: 35,
  CRITICAL: 18,
  MAJOR: 8,
  MINOR: 3,
  INFO: 0,
}

export function isSeverity(value: string): value is FindingSeverity {
  return SEVERITIES.includes(value as FindingSeverity)
}

export function assertSeverity(value: string): FindingSeverity {
  if (!isSeverity(value)) {
    throw new ValidationError(`Invalid severity: ${value}`, {
      severity: [`Must be one of: ${SEVERITIES.join(', ')}`],
    })
  }
  return value
}

/** Choose the more severe of two severities. */
export function maxSeverity(a: FindingSeverity, b: FindingSeverity): FindingSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b
}

// ---------------- Lifecycle status ----------------

export type FindingStatus =
  | 'OPEN'
  | 'ACKNOWLEDGED'
  | 'IN_PROGRESS'
  | 'RESOLVED'
  | 'REOPENED'
  | 'IGNORED'
  | 'ACCEPTED_RISK'
  | 'FALSE_POSITIVE'

export const STATUSES: readonly FindingStatus[] = [
  'OPEN',
  'ACKNOWLEDGED',
  'IN_PROGRESS',
  'RESOLVED',
  'REOPENED',
  'IGNORED',
  'ACCEPTED_RISK',
  'FALSE_POSITIVE',
] as const

/** Terminal states (no automatic reopening from these). */
export const TERMINAL_STATUSES: readonly FindingStatus[] = [
  'RESOLVED',
  'IGNORED',
  'ACCEPTED_RISK',
  'FALSE_POSITIVE',
] as const

/** States considered "fixed" for delivery-readiness purposes. */
export const FIXED_STATUSES: readonly FindingStatus[] = ['RESOLVED', 'ACCEPTED_RISK', 'FALSE_POSITIVE']

/** States considered "open" (counted as outstanding). */
export const OPEN_STATUSES: readonly FindingStatus[] = [
  'OPEN',
  'ACKNOWLEDGED',
  'IN_PROGRESS',
  'REOPENED',
]

export function isStatus(value: string): value is FindingStatus {
  return STATUSES.includes(value as FindingStatus)
}

export function assertStatus(value: string): FindingStatus {
  if (!isStatus(value)) {
    throw new ValidationError(`Invalid finding status: ${value}`, {
      status: [`Must be one of: ${STATUSES.join(', ')}`],
    })
  }
  return value
}

/**
 * Allowed transitions for the lifecycle state machine.
 * Any transition not present here is rejected with a 409 Conflict.
 *
 * Design notes:
 *   - RESOLVED can only transition to REOPENED (manually by a user, or
 *     automatically by the worker when the fingerprint re-appears).
 *   - IGNORED/ACCEPTED_RISK/FALSE_POSITIVE are "intentional decision"
 *     states; they can be reopened explicitly, but the worker will NOT
 *     auto-reopen from them (only from RESOLVED).
 *   - ACKNOWLEDGED/IN_PROGRESS are working states that can move forward
 *     (to RESOLVED) or backward (to OPEN) at any time.
 */
const TRANSITION_MATRIX: Record<FindingStatus, FindingStatus[]> = {
  OPEN: ['ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED', 'IGNORED', 'ACCEPTED_RISK', 'FALSE_POSITIVE'],
  ACKNOWLEDGED: ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'IGNORED', 'ACCEPTED_RISK', 'FALSE_POSITIVE'],
  IN_PROGRESS: ['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'IGNORED', 'ACCEPTED_RISK', 'FALSE_POSITIVE'],
  RESOLVED: ['REOPENED'],
  REOPENED: ['ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED', 'IGNORED', 'ACCEPTED_RISK', 'FALSE_POSITIVE'],
  IGNORED: ['REOPENED', 'OPEN'],
  ACCEPTED_RISK: ['REOPENED', 'OPEN'],
  FALSE_POSITIVE: ['REOPENED', 'OPEN'],
}

export function canTransition(from: FindingStatus, to: FindingStatus): boolean {
  return TRANSITION_MATRIX[from]?.includes(to) ?? false
}

export function assertCanTransition(from: FindingStatus, to: FindingStatus): void {
  if (!canTransition(from, to)) {
    throw new ValidationError(
      `Invalid finding status transition: ${from} → ${to}`,
      { from, to: [`Allowed: ${(TRANSITION_MATRIX[from] ?? []).join(', ') || '(none)'}`] },
    )
  }
}

// ---------------- Business impact ----------------

/**
 * Business impact categories. Findings may have multiple impacts
 * (stored as comma-separated in Finding.businessImpact).
 */
export type BusinessImpact =
  | 'REVENUE_LOSS'
  | 'CONVERSION_LOSS'
  | 'BRAND_DAMAGE'
  | 'ACCESSIBILITY_BARRIER'
  | 'LEGAL_COMPLIANCE'
  | 'SEO_TRAFFIC_LOSS'
  | 'USER_EXPERIENCE'
  | 'SECURITY_EXPOSURE'
  | 'PERFORMANCE_DEGRADATION'
  | 'LOCALIZATION_BARRIER'
  | 'TECHNICAL_DEBT'
  | 'OTHER'

export const BUSINESS_IMPACTS: readonly BusinessImpact[] = [
  'REVENUE_LOSS',
  'CONVERSION_LOSS',
  'BRAND_DAMAGE',
  'ACCESSIBILITY_BARRIER',
  'LEGAL_COMPLIANCE',
  'SEO_TRAFFIC_LOSS',
  'USER_EXPERIENCE',
  'SECURITY_EXPOSURE',
  'PERFORMANCE_DEGRADATION',
  'LOCALIZATION_BARRIER',
  'TECHNICAL_DEBT',
  'OTHER',
] as const

export const BUSINESS_IMPACT_LABELS: Record<BusinessImpact, string> = {
  REVENUE_LOSS: 'Revenue loss',
  CONVERSION_LOSS: 'Conversion loss',
  BRAND_DAMAGE: 'Brand damage',
  ACCESSIBILITY_BARRIER: 'Accessibility barrier',
  LEGAL_COMPLIANCE: 'Legal / compliance',
  SEO_TRAFFIC_LOSS: 'SEO traffic loss',
  USER_EXPERIENCE: 'User experience',
  SECURITY_EXPOSURE: 'Security exposure',
  PERFORMANCE_DEGRADATION: 'Performance degradation',
  LOCALIZATION_BARRIER: 'Localization barrier',
  TECHNICAL_DEBT: 'Technical debt',
  OTHER: 'Other',
}

export function isBusinessImpact(value: string): value is BusinessImpact {
  return BUSINESS_IMPACTS.includes(value as BusinessImpact)
}

/** Parse a comma-separated business-impact string into validated values. */
export function parseBusinessImpacts(input: string | null | undefined): BusinessImpact[] {
  if (!input) return []
  const parts = input
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  const out: BusinessImpact[] = []
  for (const p of parts) {
    if (isBusinessImpact(p)) {
      out.push(p)
    }
  }
  // Deduplicate, preserve order.
  return Array.from(new Set(out))
}

/** Serialize a list of business impacts back to the comma-separated storage form. */
export function serializeBusinessImpacts(impacts: BusinessImpact[]): string {
  return impacts.join(',')
}

/**
 * Deterministic mapping from (category, checkId) → severity.
 * Analyzers should consult this when emitting FindingCandidate so that
 * severity is consistent across runs and cannot be silently changed.
 *
 * If a (category, checkId) pair is not in this table, the analyzer's
 * own severity is used — but it is logged so it can be normalized later.
 */
const DETERMINISTIC_SEVERITY: Record<string, FindingSeverity> = {
  // HTTP_NAVIGATION
  'HTTP_NAVIGATION:server_error_5xx': 'CRITICAL',
  'HTTP_NAVIGATION:broken_link_404': 'MAJOR',
  'HTTP_NAVIGATION:redirect_loop': 'MAJOR',
  'HTTP_NAVIGATION:excessive_redirects': 'MAJOR',
  'HTTP_NAVIGATION:failed_network_request': 'MAJOR',
  'HTTP_NAVIGATION:mixed_content': 'MAJOR',
  'HTTP_NAVIGATION:invalid_content_type': 'MAJOR',
  'HTTP_NAVIGATION:missing_title': 'MINOR',
  'HTTP_NAVIGATION:cross_origin_canonical': 'MINOR',
  'HTTP_NAVIGATION:broken_favicon': 'INFO',
  'HTTP_NAVIGATION:broken_manifest': 'MINOR',
  // RUNTIME
  'RUNTIME:uncaught_page_error': 'CRITICAL',
  'RUNTIME:console_error': 'MAJOR',
  'RUNTIME:console_warning': 'MINOR',
  'RUNTIME:csp_violation': 'MAJOR',
  'RUNTIME:page_crash': 'BLOCKER',
  // RESPONSIVE
  'RESPONSIVE:horizontal_overflow': 'MAJOR',
  'RESPONSIVE:out_of_viewport_element': 'MAJOR',
  'RESPONSIVE:fixed_covering_interactive': 'MAJOR',
  'RESPONSIVE:clipped_text': 'MAJOR',
  'RESPONSIVE:tap_target_too_small': 'MAJOR',
  'RESPONSIVE:input_font_too_small': 'MINOR',
  'RESPONSIVE:root_font_too_small': 'MINOR',
  'RESPONSIVE:table_overflow': 'MINOR',
  'RESPONSIVE:image_overflow': 'MINOR',
  // ACCESSIBILITY
  'ACCESSIBILITY:axe_violation': 'MAJOR',
  'ACCESSIBILITY:missing_html_lang': 'MAJOR',
  'ACCESSIBILITY:heading_hierarchy': 'MAJOR',
  'ACCESSIBILITY:missing_frame_title': 'MAJOR',
  'ACCESSIBILITY:missing_bypass_mechanism': 'MAJOR',
  'ACCESSIBILITY:unnamed_interactive': 'MAJOR',
  // FORMS
  'FORMS:missing_label': 'MAJOR',
  'FORMS:missing_autocomplete': 'MINOR',
  'FORMS:wrong_autocomplete': 'MINOR',
  'FORMS:suboptimal_input_type': 'MINOR',
  'FORMS:password_field_without_autocomplete': 'MAJOR',
  'FORMS:missing_submit_button': 'MAJOR',
  'FORMS:disabled_submit': 'MAJOR',
  'FORMS:required_without_aria': 'MINOR',
  'FORMS:missing_error_region': 'MAJOR',
  // PERFORMANCE
  'PERFORMANCE:slow_ttfb': 'MAJOR',
  'PERFORMANCE:slow_lcp': 'MAJOR',
  'PERFORMANCE:poor_cls': 'MAJOR',
  'PERFORMANCE:poor_inp': 'MAJOR',
  'PERFORMANCE:long_task': 'MINOR',
  'PERFORMANCE:render_blocking_resource': 'MINOR',
  'PERFORMANCE:large_resource': 'MINOR',
  // SECURITY (passive)
  'SECURITY:missing_security_header': 'MAJOR',
  'SECURITY:insecure_cookie': 'MAJOR',
  'SECURITY:sensitive_url_param': 'CRITICAL',
  'SECURITY:insecure_credential_post': 'CRITICAL',
  'SECURITY:source_map_exposure': 'MAJOR',
  'SECURITY:secret_in_dom': 'BLOCKER',
  'SECURITY:missing_sri': 'MAJOR',
  'SECURITY:iframe_without_sandbox': 'MAJOR',
  'SECURITY:public_stack_trace': 'MAJOR',
  // SEO
  'SEO:missing_title': 'MAJOR',
  'SEO:short_title': 'MINOR',
  'SEO:long_title': 'MINOR',
  'SEO:missing_description': 'MINOR',
  'SEO:missing_canonical': 'MINOR',
  'SEO:bad_viewport': 'MAJOR',
  'SEO:noindex': 'MAJOR',
  'SEO:missing_og_tags': 'MINOR',
  'SEO:missing_twitter_card': 'INFO',
  'SEO:missing_jsonld': 'INFO',
  'SEO:missing_favicon': 'INFO',
  'SEO:missing_manifest': 'INFO',
  'SEO:missing_html_lang': 'MAJOR',
  'SEO:thin_content': 'MINOR',
}

/**
 * Return the canonical deterministic severity for a (category, checkId) pair.
 * Returns null if no deterministic rule exists — the analyzer's severity is
 * used in that case, but should be normalized later.
 */
export function deterministicSeverity(
  category: string,
  checkId: string,
): FindingSeverity | null {
  return DETERMINISTIC_SEVERITY[`${category}:${checkId}`] ?? null
}

/**
 * Resolve a finding's final severity.
 *
 *   1. If a deterministic rule exists for (category, checkId) → use it.
 *   2. Otherwise, use the analyzer's proposed severity.
 *   3. If `aiProposed` is provided AND it differs from the deterministic
 *      severity, the deterministic one wins — but the caller should record
 *      an audit entry so the override is visible.
 */
export function resolveSeverity(
  category: string,
  checkId: string,
  analyzerProposed: FindingSeverity,
  aiProposed?: FindingSeverity,
): { severity: FindingSeverity; overridden: boolean } {
  const det = deterministicSeverity(category, checkId)
  if (det) {
    return {
      severity: det,
      overridden: aiProposed !== undefined && aiProposed !== det,
    }
  }
  // No deterministic rule — analyzer's severity stands.
  return { severity: analyzerProposed, overridden: false }
}

// ---------------- Confidence ----------------

export type FindingConfidence = 'HIGH' | 'MEDIUM' | 'LOW'

export const CONFIDENCES: readonly FindingConfidence[] = ['HIGH', 'MEDIUM', 'LOW'] as const

export function isConfidence(value: string): value is FindingConfidence {
  return CONFIDENCES.includes(value as FindingConfidence)
}

export function assertConfidence(value: string): FindingConfidence {
  if (!isConfidence(value)) {
    throw new ValidationError(`Invalid confidence: ${value}`, {
      confidence: [`Must be one of: ${CONFIDENCES.join(', ')}`],
    })
  }
  return value
}

// ---------------- Tags ----------------

/** Maximum tags per finding. */
export const MAX_TAGS = 12
export const MAX_TAG_LENGTH = 40

/** Tag character whitelist: letters, digits, dashes, underscores, spaces. */
const TAG_PATTERN = /^[\p{L}\p{N} _-]{1,40}$/u

/**
 * Parse a comma-separated tag string into validated, deduplicated tags.
 * Throws ValidationError on invalid input.
 */
export function parseTags(input: string | null | undefined): string[] {
  if (!input) return []
  const parts = input
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length > MAX_TAGS) {
    throw new ValidationError(`Too many tags (max ${MAX_TAGS})`, { tags: [`Max ${MAX_TAGS}`] })
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const p of parts) {
    const lower = p.toLowerCase()
    if (seen.has(lower)) continue
    if (!TAG_PATTERN.test(p)) {
      throw new ValidationError(`Invalid tag: "${p}"`, {
        tags: ['Tags must be 1–40 chars; letters, digits, spaces, dashes, underscores only'],
      })
    }
    seen.add(lower)
    out.push(p)
  }
  return out
}

export function serializeTags(tags: string[]): string {
  return tags.join(',')
}
