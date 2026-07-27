/**
 * Accessibility analyzer — ProofPilot worker (Phase 5)
 *
 * Uses axe-core (already installed in node_modules) for WCAG 2.2 AA checks,
 * plus manual checks for issues axe doesn't cover:
 *   - Missing <html lang>
 *   - Missing bypass mechanism (skip link / landmark)
 *   - Heading hierarchy (h1 → h2 → h3, no skipped levels)
 *   - Heading count (zero or multiple h1s)
 *   - Frame/iframe titles
 *   - Touch target size (deferred to responsive analyzer)
 *
 * axe-core is injected via page.addInitScript to monitor CSP-violating
 * scripts, then run via page.evaluate.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Analyzer, AnalyzerContext, FindingCandidate } from './types'

/** Map axe-core impact → ProofPilot severity. */
function axeImpactToSeverity(impact: string | undefined): 'CRITICAL' | 'MAJOR' | 'MINOR' | 'INFO' {
  switch (impact) {
    case 'critical': return 'CRITICAL'
    case 'serious': return 'MAJOR'
    case 'moderate': return 'MINOR'
    case 'minor': return 'INFO'
    default: return 'MINOR'
  }
}

/** Load the axe-core source once (cached). */
let axeSource: string | null = null
function getAxeSource(): string {
  if (axeSource) return axeSource
  // Resolve from the parent node_modules (worker shares dependencies with the Next.js app).
  const candidates = [
    join(process.cwd(), 'node_modules', 'axe-core', 'axe.min.js'),
    join(process.cwd(), '..', '..', 'node_modules', 'axe-core', 'axe.min.js'),
    join(__dirname, '..', '..', '..', '..', 'node_modules', 'axe-core', 'axe.min.js'),
  ]
  for (const p of candidates) {
    try {
      axeSource = readFileSync(p, 'utf8')
      return axeSource
    } catch {
      // try next
    }
  }
  throw new Error('Could not load axe-core source. Ensure axe-core is installed in the project node_modules.')
}

/** Rule IDs to skip (we have dedicated analyzers or they're too noisy). */
const AXE_SKIP_RULES = new Set<string>([
  'region' /* covered by landmark check */,
  'heading-order' /* covered by manual check */,
  'empty-heading' /* too noisy */,
])

interface AxeResult {
  id: string
  impact: string | null
  description: string
  help: string
  helpUrl: string
  tags: string[]
  nodes: Array<{
    html: string
    target: string[]
    failureSummary?: string
    impact: string | null
  }>
}

interface AxeRunOutput {
  violations: AxeResult[]
  incomplete: AxeResult[]
  passes: number
  inapplicable: number
}

/** Run axe-core in the page context. */
async function runAxe(ctx: AnalyzerContext): Promise<AxeRunOutput | null> {
  try {
    // Inject axe-core source
    const source = getAxeSource()
    await ctx.page.addInitScript(source)
    // If the page already loaded, inject manually
    await ctx.page.evaluate(source).catch(() => {
      // Page may be in a state where eval fails; we'll skip axe.
    })

    const result = await ctx.page.evaluate(async (skipRules) => {
      // @ts-expect-error — axe is injected at runtime
      const axe = (window as unknown as { axe?: { run: (opts: Record<string, unknown>) => Promise<AxeRunOutput> } }).axe
      if (!axe) return null
      return axe.run({
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
        },
        rules: Object.fromEntries(skipRules.map((r: string) => [r, 'off'])),
        resultTypes: ['violations', 'incomplete'],
      })
    }, Array.from(AXE_SKIP_RULES))

    return result
  } catch (err) {
    // axe failed to run (CSP, page state, etc.) — we'll fall back to manual checks.
    void err
    return null
  }
}

/** Manual checks axe doesn't cover. */
async function runManualA11yChecks(ctx: AnalyzerContext): Promise<FindingCandidate[]> {
  const findings: FindingCandidate[] = []

  const checks = await ctx.page.evaluate(() => {
    const out: Array<Record<string, unknown>> = []

    // 1. Missing <html lang>
    const htmlLang = document.documentElement.getAttribute('lang')
    if (!htmlLang || htmlLang.trim() === '') {
      out.push({ check: 'missing_html_lang' })
    }

    // 2. Heading hierarchy
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
    const headingLevels = headings.map((h) => parseInt(h.tagName[1], 10))
    if (headings.length === 0) {
      out.push({ check: 'no_headings' })
    } else {
      const h1Count = headingLevels.filter((l) => l === 1).length
      if (h1Count === 0) {
        out.push({ check: 'no_h1' })
      } else if (h1Count > 1) {
        out.push({ check: 'multiple_h1', count: h1Count })
      }
      // Skipped levels (e.g. h1 → h3 without h2)
      for (let i = 1; i < headingLevels.length; i++) {
        if (headingLevels[i] > headingLevels[i - 1] + 1) {
          out.push({
            check: 'skipped_heading_level',
            from: headingLevels[i - 1],
            to: headingLevels[i],
          })
          break
        }
      }
    }

    // 3. Frames without title
    const frames = Array.from(document.querySelectorAll('iframe, frame'))
    const untitledFrames = frames.filter((f) => !f.getAttribute('title') || f.getAttribute('title')?.trim() === '')
    if (untitledFrames.length > 0) {
      out.push({ check: 'frame_without_title', count: untitledFrames.length })
    }

    // 4. Missing bypass mechanism (skip link or landmark with accessible name)
    const skipLink = document.querySelector('a[href^="#"]:is([class*="skip"], [class*="sr-only"])')
    const mainLandmark = document.querySelector('main, [role="main"]')
    if (!skipLink && !mainLandmark) {
      out.push({ check: 'no_bypass_mechanism' })
    }

    // 5. Buttons/links with empty accessible names
    const unnamedButtons = Array.from(document.querySelectorAll('button, [role="button"], a[href]')).filter((el) => {
      const name = (el.getAttribute('aria-label') ?? '').trim()
      const text = (el.textContent ?? '').trim()
      const title = (el.getAttribute('title') ?? '').trim()
      return name === '' && text === '' && title === ''
    })
    if (unnamedButtons.length > 0) {
      out.push({ check: 'unnamed_interactive', count: unnamedButtons.length })
    }

    return out
  }).catch(() => [] as Array<Record<string, unknown>>)

  for (const c of checks) {
    switch (c.check) {
      case 'missing_html_lang':
        findings.push({
          checkId: 'a11y.missing_html_lang',
          category: 'ACCESSIBILITY',
          severity: 'MINOR',
          title: 'Missing html[lang] attribute',
          description: 'The <html> element has no lang attribute. Screen readers cannot determine the language of the page content.',
          remediation: 'Add a lang attribute to the <html> element, e.g. <html lang="en">.',
          messageKey: 'missing-html-lang',
        })
        break
      case 'no_headings':
        findings.push({
          checkId: 'a11y.no_headings',
          category: 'ACCESSIBILITY',
          severity: 'MINOR',
          title: 'Page has no headings',
          description: 'The page has no heading elements (h1–h6). Headings help screen reader users navigate the page structure.',
          remediation: 'Add at least one h1 describing the page, and use h2–h6 for sub-sections.',
          messageKey: 'no-headings',
        })
        break
      case 'no_h1':
        findings.push({
          checkId: 'a11y.no_h1',
          category: 'ACCESSIBILITY',
          severity: 'MAJOR',
          title: 'Missing h1 heading',
          description: 'The page has no h1 element. The h1 should describe the page’s main purpose and is the primary navigation landmark for screen reader users.',
          remediation: 'Add a single, descriptive <h1> at the top of the main content.',
          messageKey: 'no-h1',
        })
        break
      case 'multiple_h1':
        findings.push({
          checkId: 'a11y.multiple_h1',
          category: 'ACCESSIBILITY',
          severity: 'MINOR',
          title: `Multiple h1 headings (${c.count})`,
          description: `The page has ${c.count} h1 elements. Use a single h1 per page; use h2–h6 for sub-sections.`,
          remediation: 'Convert extra h1s to h2s.',
          messageKey: 'multiple-h1',
          evidence: { count: c.count },
        })
        break
      case 'skipped_heading_level':
        findings.push({
          checkId: 'a11y.skipped_heading_level',
          category: 'ACCESSIBILITY',
          severity: 'MINOR',
          title: `Skipped heading level (h${c.from} → h${c.to})`,
          description: `Heading levels skip from h${c.from} to h${c.to}. Screen reader users may miss content when levels are skipped.`,
          remediation: `Use h${c.from + 1} before h${c.to}, or restructure the heading hierarchy.`,
          messageKey: `skipped-heading-${c.from}-${c.to}`,
          evidence: { from: c.from, to: c.to },
        })
        break
      case 'frame_without_title':
        findings.push({
          checkId: 'a11y.frame_without_title',
          category: 'ACCESSIBILITY',
          severity: 'MAJOR',
          title: `${c.count} frame(s) without title`,
          description: 'iframe/frame elements without a title are inaccessible to screen reader users, who cannot determine their purpose.',
          remediation: 'Add a descriptive title attribute to every iframe.',
          messageKey: 'frame-without-title',
          evidence: { count: c.count },
        })
        break
      case 'no_bypass_mechanism':
        findings.push({
          checkId: 'a11y.no_bypass_mechanism',
          category: 'ACCESSIBILITY',
          severity: 'MINOR',
          title: 'No bypass mechanism (skip link or main landmark)',
          description: 'The page has no skip link and no <main> landmark. Keyboard users must tab through all header/nav content before reaching the main content.',
          remediation: 'Add a "Skip to main content" link as the first focusable element, and wrap main content in a <main> element.',
          messageKey: 'no-bypass-mechanism',
        })
        break
      case 'unnamed_interactive':
        findings.push({
          checkId: 'a11y.unnamed_interactive',
          category: 'ACCESSIBILITY',
          severity: 'MAJOR',
          title: `${c.count} interactive element(s) without accessible name`,
          description: 'Buttons or links with no text, aria-label, or title are invisible to screen readers and unusable by keyboard users.',
          remediation: 'Add text content, an aria-label, or a title attribute to every interactive element.',
          messageKey: 'unnamed-interactive',
          evidence: { count: c.count },
        })
        break
      default:
        // Unknown check — skip
        break
    }
  }

  return findings
}

export const accessibilityAnalyzer: Analyzer = {
  id: 'accessibility',
  category: 'ACCESSIBILITY',
  async run(ctx: AnalyzerContext): Promise<FindingCandidate[]> {
    const findings: FindingCandidate[] = []

    // Run axe-core
    const axeResult = await runAxe(ctx)
    if (axeResult) {
      for (const violation of axeResult.violations) {
        const severity = axeImpactToSeverity(violation.impact ?? undefined)
        // Cap the number of nodes we report per rule (axe can return hundreds)
        const nodes = violation.nodes.slice(0, 5)
        findings.push({
          checkId: `a11y.axe.${violation.id}`,
          category: 'ACCESSIBILITY',
          severity,
          title: violation.help,
          description: `${violation.description}${violation.helpUrl ? ` (see ${violation.helpUrl})` : ''}`,
          remediation: violation.helpUrl ? `See ${violation.helpUrl} for remediation guidance.` : undefined,
          selector: nodes[0]?.target?.[0],
          messageKey: `axe-${violation.id}`,
          evidence: {
            ruleId: violation.id,
            impact: violation.impact,
            tags: violation.tags,
            nodeCount: violation.nodes.length,
            nodes: nodes.map((n) => ({
              html: n.html.slice(0, 300),
              target: n.target,
              failureSummary: n.failureSummary,
            })),
          },
        })
      }
    }

    // Manual checks
    const manualFindings = await runManualA11yChecks(ctx)
    findings.push(...manualFindings)

    return findings
  },
}
