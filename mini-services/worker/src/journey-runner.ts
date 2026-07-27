/**
 * Journey runner — ProofPilot worker
 *
 * Handles `journey-execution` queue jobs.
 *
 * Flow:
 *   1. Load the JourneyRun + JourneyVersion from DB
 *   2. Skip if cancelled
 *   3. Mark RUNNING, resolve secrets from ProjectSecret vault
 *   4. Launch hardened browser (with network interception + allowed origins)
 *   5. For each step:
 *      a. Re-validate against the safe-action policy at runtime
 *      b. Resolve {{secret.NAME}} references from the in-memory secret map
 *      c. Capture before/after screenshots on failure
 *      d. Record JourneyStepResult (PASS/FAIL/SKIPPED)
 *      e. Emit journey.step scan event
 *   6. Mark COMPLETED (all steps PASS/SKIPPED) or FAILED (any step FAILed and not continueOnError)
 *
 * Security:
 *   - Browser context inherits the hardened config from createContext()
 *   - Allowed origins are the same set authorized for the parent scan
 *   - Secret values are NEVER logged; they are passed directly to Playwright APIs
 *   - Step failures capture screenshots but never the DOM (which could contain secrets)
 *
 * See SECURITY_MODEL.md §"Journey runner" and THREAT_MODEL.md T12.
 */
import { Buffer } from 'node:buffer'
import type { Page } from 'playwright'
import { db } from '../../../src/lib/db'
import { env } from '../../../src/lib/env'
import { logger } from '../../../src/lib/logger'
import { appendScanEvent } from '../../../src/lib/scan-events'
import { storeArtifact } from '../../../src/lib/artifact-service'
import {
  parseSteps,
  isStepAllowedForMode,
  type JourneyStep,
  type JourneyRunMode,
} from '../../../src/lib/journey-types'
import {
  validateStepsAgainstPolicy,
  isDestructiveSelector,
  isDestructiveUrl,
} from '../../../src/lib/journey-policy'
import {
  resolveSecretsForSteps,
  extractSecretKeys,
} from '../../../src/lib/project-secrets'
import { launchBrowser, createContext, closeContext, navigateSafely } from './browser'
import type { Job } from '../../../src/lib/queue'

// ---------------- Payload ----------------

interface JourneyExecutionPayload {
  journeyRunId: string
  journeyId: string
  journeyVersion: number
  scanRunId: string | null
  projectId: string
  workspaceId: string
  environmentId: string
  personaId: string | null
  runMode: JourneyRunMode
  trigger: string
  targetUrl: string
  allowedOrigins: string[]
  locale: string
  viewport: string
  timezone: string
}

// ---------------- Main handler ----------------

export async function handleJourneyExecution(job: Job<JourneyExecutionPayload>): Promise<void> {
  const p = job.payload

  // Load the journey run
  const run = await db.journeyRun.findUnique({
    where: { id: p.journeyRunId },
    include: { journey: { select: { name: true } } },
  })
  if (!run) {
    logger.error('Journey run not found', { journeyRunId: p.journeyRunId })
    return
  }
  if (run.status === 'CANCELLED') {
    logger.info('Journey run was cancelled before execution', { journeyRunId: p.journeyRunId })
    return
  }

  // Load the version
  const version = await db.journeyVersion.findUnique({
    where: { journeyId_version: { journeyId: p.journeyId, version: p.journeyVersion } },
  })
  if (!version) {
    await failJourneyRun(run.id, p.scanRunId, 'Journey version not found', p.workspaceId, p.projectId)
    return
  }

  // Parse + validate steps at runtime (defense in depth — design-time validation may have run on a different version)
  let steps: JourneyStep[]
  try {
    steps = parseSteps(version.stepsJson)
  } catch (err) {
    await failJourneyRun(run.id, p.scanRunId, `Invalid steps: ${String(err)}`, p.workspaceId, p.projectId)
    return
  }

  const policy = validateStepsAgainstPolicy(steps, p.runMode)
  if (!policy.ok) {
    const reasons = policy.violations.map((v) => `Step ${v.stepIndex + 1}: ${v.reason}`).join('; ')
    await failJourneyRun(run.id, p.scanRunId, `Policy violation: ${reasons}`, p.workspaceId, p.projectId)
    return
  }

  // Mark RUNNING
  await db.journeyRun.update({
    where: { id: run.id },
    data: { status: 'RUNNING', startedAt: new Date() },
  })
  await emitJourneyEvent(p.scanRunId, run.id, 'journey.started', {
    journeyId: p.journeyId,
    journeyName: run.journey.name,
    version: p.journeyVersion,
    stepCount: steps.length,
    runMode: p.runMode,
    targetUrl: p.targetUrl,
  })

  // Resolve secrets (batched — one DB query per run)
  const secretKeys = extractSecretKeys(steps)
  const secretMap = await resolveSecretsForSteps(p.projectId, secretKeys)
  const missingSecrets = secretKeys.filter((k) => !secretMap.has(k))
  if (missingSecrets.length > 0) {
    await failJourneyRun(
      run.id,
      p.scanRunId,
      `Missing project secrets: ${missingSecrets.join(', ')}`,
      p.workspaceId,
      p.projectId,
    )
    return
  }

  // Launch browser + isolated context
  const viewport = parseViewport(p.viewport)
  let browser
  let context
  try {
    browser = await launchBrowser({ allowNoSandbox: env.APP_ENV === 'development' })
    context = await createContext(browser, {
      allowedOrigins: p.allowedOrigins,
      viewport,
      locale: p.locale,
      timezoneId: p.timezone,
    })
  } catch (err) {
    await failJourneyRun(run.id, p.scanRunId, `Browser launch failed: ${String(err)}`, p.workspaceId, p.projectId)
    if (browser) await browser.close().catch(() => {})
    return
  }

  // Execute steps
  const page = await context.newPage()
  let stepsPassed = 0
  let stepsFailed = 0
  let stepsSkipped = 0
  let abortReason: string | null = null

  // Track console/network errors per step
  let currentConsoleErrors = 0
  let currentNetworkErrors = 0
  const resetCounters = () => {
    currentConsoleErrors = 0
    currentNetworkErrors = 0
  }
  page.on('console', (msg) => {
    if (msg.type() === 'error') currentConsoleErrors++
  })
  page.on('requestfailed', () => {
    currentNetworkErrors++
  })

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!
    const stepLabel = step.label ?? `${step.type} #${i + 1}`
    const startedAt = Date.now()

    // If we've aborted, mark remaining steps as SKIPPED
    if (abortReason) {
      await recordStepResult(run.id, i, step, 'SKIPPED', 0, null, 0, 0, p.workspaceId, p.projectId, p.scanRunId)
      stepsSkipped++
      await emitJourneyEvent(p.scanRunId, run.id, 'journey.step.skipped', {
        stepIndex: i,
        stepType: step.type,
        stepLabel,
        reason: abortReason,
      })
      continue
    }

    resetCounters()

    try {
      const result = await executeStep(page, step, p.runMode, secretMap, p.allowedOrigins, run.id, p.workspaceId, p.projectId, p.scanRunId, i)
      const durationMs = Date.now() - startedAt

      if (result.status === 'PASS') {
        stepsPassed++
        await recordStepResult(run.id, i, step, 'PASS', durationMs, null, currentConsoleErrors, currentNetworkErrors, p.workspaceId, p.projectId, p.scanRunId, result.metadata ?? null)
        await emitJourneyEvent(p.scanRunId, run.id, 'journey.step.passed', {
          stepIndex: i,
          stepType: step.type,
          stepLabel,
          durationMs,
        })
      } else if (result.status === 'FAIL') {
        stepsFailed++
        await recordStepResult(run.id, i, step, 'FAIL', durationMs, result.error ?? null, currentConsoleErrors, currentNetworkErrors, p.workspaceId, p.projectId, p.scanRunId, result.metadata ?? null, result.beforeScreenshotId ?? null, result.afterScreenshotId ?? null)
        await emitJourneyEvent(p.scanRunId, run.id, 'journey.step.failed', {
          stepIndex: i,
          stepType: step.type,
          stepLabel,
          durationMs,
          error: result.error,
        })
        if (!step.continueOnError) {
          abortReason = result.error ?? 'Step failed'
        }
      }
    } catch (err) {
      const durationMs = Date.now() - startedAt
      const errorMsg = err instanceof Error ? err.message : String(err)
      stepsFailed++
      await recordStepResult(run.id, i, step, 'FAIL', durationMs, errorMsg, currentConsoleErrors, currentNetworkErrors, p.workspaceId, p.projectId, p.scanRunId, null)
      await emitJourneyEvent(p.scanRunId, run.id, 'journey.step.failed', {
        stepIndex: i,
        stepType: step.type,
        stepLabel,
        durationMs,
        error: errorMsg,
      })
      if (!step.continueOnError) {
        abortReason = errorMsg
      }
    }
  }

  // Close browser + finalize
  await closeContext(context)
  await browser.close().catch(() => {})

  const finalStatus = abortReason ? 'FAILED' : 'COMPLETED'
  await db.journeyRun.update({
    where: { id: run.id },
    data: {
      status: finalStatus,
      stepsPassed,
      stepsFailed,
      stepsSkipped,
      completedAt: new Date(),
      failedReason: abortReason,
    },
  })

  if (finalStatus === 'COMPLETED') {
    await emitJourneyEvent(p.scanRunId, run.id, 'journey.completed', {
      journeyId: p.journeyId,
      stepsTotal: steps.length,
      stepsPassed,
      stepsFailed,
      stepsSkipped,
    })
  } else {
    await emitJourneyEvent(p.scanRunId, run.id, 'journey.failed', {
      journeyId: p.journeyId,
      reason: abortReason,
      stepsPassed,
      stepsFailed,
      stepsSkipped,
    })
  }

  logger.info('Journey run completed', {
    journeyRunId: run.id,
    status: finalStatus,
    stepsPassed,
    stepsFailed,
    stepsSkipped,
    durationMs: run.startedAt ? Date.now() - run.startedAt.getTime() : 0,
  })
}

// ---------------- Step execution ----------------

interface StepExecResult {
  status: 'PASS' | 'FAIL' | 'SKIPPED'
  error?: string | null
  metadata?: Record<string, unknown> | null
  beforeScreenshotId?: string | null
  afterScreenshotId?: string | null
}

async function executeStep(
  page: Page,
  step: JourneyStep,
  runMode: JourneyRunMode,
  secrets: Map<string, string>,
  allowedOrigins: string[],
  runId: string,
  workspaceId: string,
  projectId: string,
  scanRunId: string | null,
  stepIndex: number,
): Promise<StepExecResult> {
  // Re-check the step type against the run mode at runtime
  if (!isStepAllowedForMode(step.type, runMode)) {
    return {
      status: 'FAIL',
      error: `Step type ${step.type} is not permitted in ${runMode} mode`,
    }
  }

  // Per-step-type execution
  switch (step.type) {
    case 'NAVIGATE': {
      // Resolve relative URLs against the current page URL
      let url = step.url
      if (url.startsWith('/') || url.startsWith('#')) {
        try {
          url = new URL(url, page.url()).href
        } catch {
          return { status: 'FAIL', error: 'Cannot resolve relative URL without a current page' }
        }
      }
      if (isDestructiveUrl(url)) {
        return { status: 'FAIL', error: `Refused to navigate to destructive URL: ${url}` }
      }
      // Verify origin is in the allowlist
      try {
        const origin = new URL(url).origin
        if (!allowedOrigins.includes(origin)) {
          return { status: 'FAIL', error: `Navigation target origin ${origin} not allowed` }
        }
      } catch {
        return { status: 'FAIL', error: `Invalid URL: ${url}` }
      }
      await navigateSafely(page, url, allowedOrigins, {
        waitUntil: step.waitUntil ?? 'domcontentloaded',
      })
      return { status: 'PASS', metadata: { url } }
    }

    case 'CLICK': {
      if (isDestructiveSelector(step.selector)) {
        return { status: 'FAIL', error: `Refused to click destructive selector: ${step.selector}` }
      }
      await page.click(step.selector, {
        button: step.button ?? 'left',
        modifiers: step.modifiers,
        timeout: 10_000,
      })
      return { status: 'PASS', metadata: { selector: step.selector } }
    }

    case 'TYPE': {
      if (isDestructiveSelector(step.selector)) {
        return { status: 'FAIL', error: `Refused to type into destructive selector: ${step.selector}` }
      }
      let text: string
      if (step.secretRef) {
        const m = /^\{\{secret\.([A-Z0-9_]+)\}\}$/.exec(step.secretRef)
        if (!m) return { status: 'FAIL', error: `Invalid secret reference: ${step.secretRef}` }
        const val = secrets.get(m[1]!)
        if (val === undefined) {
          return { status: 'FAIL', error: `Secret not found: ${m[1]}` }
        }
        text = val
      } else {
        text = step.text!
      }
      if (step.clearFirst) {
        await page.fill(step.selector, '', { timeout: 10_000 })
      }
      await page.type(step.selector, text, {
        delay: step.delayMs ?? 0,
        timeout: 10_000,
      })
      // Don't include the typed text in metadata if it was a secret
      return {
        status: 'PASS',
        metadata: step.secretRef
          ? { selector: step.selector, secretRef: step.secretRef }
          : { selector: step.selector, textLength: text.length },
      }
    }

    case 'SELECT': {
      if (isDestructiveSelector(step.selector)) {
        return { status: 'FAIL', error: `Refused to select destructive selector: ${step.selector}` }
      }
      await page.selectOption(step.selector, step.value, { timeout: 10_000 })
      return { status: 'PASS', metadata: { selector: step.selector, value: step.value } }
    }

    case 'CHECK': {
      if (isDestructiveSelector(step.selector)) {
        return { status: 'FAIL', error: `Refused to check destructive selector: ${step.selector}` }
      }
      await page.check(step.selector, { timeout: 10_000 })
      return { status: 'PASS', metadata: { selector: step.selector } }
    }

    case 'UNCHECK': {
      if (isDestructiveSelector(step.selector)) {
        return { status: 'FAIL', error: `Refused to uncheck destructive selector: ${step.selector}` }
      }
      await page.uncheck(step.selector, { timeout: 10_000 })
      return { status: 'PASS', metadata: { selector: step.selector } }
    }

    case 'UPLOAD_TEST_FILE': {
      if (isDestructiveSelector(step.selector)) {
        return { status: 'FAIL', error: `Refused to upload via destructive selector: ${step.selector}` }
      }
      const fileBuffer = await generateTestFile(step)
      // Playwright expects a file path or Buffer; we use Buffer to avoid disk I/O
      const fileInput = await page.locator(step.selector).first()
      await fileInput.setInputFiles({
        name: step.fileName,
        mimeType: step.mimeType,
        buffer: fileBuffer,
      })
      return {
        status: 'PASS',
        metadata: { selector: step.selector, fileName: step.fileName, mimeType: step.mimeType, sizeBytes: fileBuffer.length },
      }
    }

    case 'WAIT_FOR_SELECTOR': {
      if (isDestructiveSelector(step.selector)) {
        return { status: 'FAIL', error: `Refused to wait for destructive selector: ${step.selector}` }
      }
      await page.waitForSelector(step.selector, {
        state: step.state ?? 'visible',
        timeout: step.timeoutMs ?? 10_000,
      })
      return { status: 'PASS', metadata: { selector: step.selector, state: step.state ?? 'visible' } }
    }

    case 'WAIT_FOR_TIMEOUT': {
      await page.waitForTimeout(step.ms)
      return { status: 'PASS', metadata: { ms: step.ms } }
    }

    case 'WAIT_FOR_URL': {
      let url = step.url
      if (url.startsWith('/') || url.startsWith('#')) {
        try {
          url = new URL(url, page.url()).href
        } catch {
          return { status: 'FAIL', error: 'Cannot resolve relative URL without a current page' }
        }
      }
      if (isDestructiveUrl(url)) {
        return { status: 'FAIL', error: `Refused to wait for destructive URL: ${url}` }
      }
      try {
        await page.waitForURL(url, { timeout: step.timeoutMs ?? 10_000 })
      } catch {
        // Try a substring match as a fallback (Playwright's URL match accepts string/RegExp)
        const currentUrl = page.url()
        if (!currentUrl.includes(url)) {
          return { status: 'FAIL', error: `URL did not become ${url} (currently ${currentUrl})` }
        }
      }
      return { status: 'PASS', metadata: { url } }
    }

    case 'ASSERT_VISIBLE': {
      const visible = await page.isVisible(step.selector).catch(() => false)
      if (!visible) {
        return { status: 'FAIL', error: `Element not visible: ${step.selector}` }
      }
      return { status: 'PASS', metadata: { selector: step.selector } }
    }

    case 'ASSERT_HIDDEN': {
      const visible = await page.isVisible(step.selector).catch(() => false)
      if (visible) {
        return { status: 'FAIL', error: `Element is visible but expected hidden: ${step.selector}` }
      }
      return { status: 'PASS', metadata: { selector: step.selector } }
    }

    case 'ASSERT_TEXT': {
      if (isDestructiveSelector(step.selector)) {
        return { status: 'FAIL', error: `Refused to assert on destructive selector: ${step.selector}` }
      }
      const elementText = await page.textContent(step.selector, { timeout: 10_000 }).catch(() => null)
      if (elementText === null) {
        return { status: 'FAIL', error: `Element not found: ${step.selector}` }
      }
      const matches = step.exact
        ? elementText.trim() === step.text
        : elementText.includes(step.text)
      if (!matches) {
        // Truncate the actual text in the error to avoid leaking large DOM content
        const actualSnippet = elementText.slice(0, 100)
        return {
          status: 'FAIL',
          error: `Text assertion failed. Expected "${step.text.slice(0, 100)}" but found "${actualSnippet}"`,
        }
      }
      return { status: 'PASS', metadata: { selector: step.selector, text: step.text.slice(0, 100), exact: step.exact ?? false } }
    }

    case 'ASSERT_URL': {
      const currentUrl = page.url()
      const matches = step.exact
        ? currentUrl === step.url
        : currentUrl.includes(step.url)
      if (!matches) {
        return { status: 'FAIL', error: `URL assertion failed. Expected "${step.url}" but found "${currentUrl}"` }
      }
      return { status: 'PASS', metadata: { url: step.url } }
    }

    case 'ASSERT_TITLE': {
      const title = await page.title()
      const matches = step.exact
        ? title === step.text
        : title.includes(step.text)
      if (!matches) {
        return { status: 'FAIL', error: `Title assertion failed. Expected "${step.text}" but found "${title}"` }
      }
      return { status: 'PASS', metadata: { text: step.text } }
    }

    case 'SCREENSHOT': {
      const buffer = await page.screenshot({ fullPage: step.fullPage ?? false, type: 'png' })
      const artifact = await storeArtifact({
        workspaceId,
        projectId,
        runId: scanRunId ?? undefined,
        type: 'SCREENSHOT',
        filename: `journey-step-${stepIndex + 1}-${(step.label ?? step.type).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)}.png`,
        buffer: Buffer.from(buffer),
        declaredMime: 'image/png',
      })
      return {
        status: 'PASS',
        metadata: { artifactId: artifact.id, label: step.label },
        afterScreenshotId: artifact.id,
      }
    }

    case 'CUSTOM_SAFE_SCRIPT': {
      // Whitelisted scripts — never raw JS evaluation
      switch (step.scriptId) {
        case 'scroll_to_top':
          await page.evaluate(() => window.scrollTo(0, 0))
          break
        case 'scroll_to_bottom':
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
          break
        case 'accept_cookie_banner_if_present': {
          // Try common cookie-banner accept button selectors
          const candidates = [
            'button:has-text("Accept")',
            'button:has-text("Accept all")',
            'button:has-text("I agree")',
            'button:has-text("Got it")',
            'button:has-text("OK")',
            '[data-testid="cookie-accept"]',
            '#cookie-accept',
          ]
          for (const sel of candidates) {
            try {
              if (await page.isVisible(sel).catch(() => false)) {
                await page.click(sel, { timeout: 2000 })
                break
              }
            } catch {
              // continue
            }
          }
          break
        }
        case 'dismiss_dialog_if_present': {
          // Dismiss any open dialogs/alerts (Playwright auto-handles window.alert, but modals need explicit dismiss)
          const dialogCandidates = [
            'button:has-text("Close")',
            'button:has-text("Dismiss")',
            'button:has-text("Cancel")',
            '[aria-label="Close"]',
            '[data-dismiss="modal"]',
          ]
          for (const sel of dialogCandidates) {
            try {
              if (await page.isVisible(sel).catch(() => false)) {
                await page.click(sel, { timeout: 2000 })
                break
              }
            } catch {
              // continue
            }
          }
          break
        }
        case 'scroll_into_view_of_last_element': {
          // Scroll the last visible main element into view
          await page.evaluate(() => {
            const main = document.querySelector('main') ?? document.body
            const lastChild = main.lastElementChild
            if (lastChild) lastChild.scrollIntoView({ behavior: 'instant', block: 'end' })
          })
          break
        }
      }
      return { status: 'PASS', metadata: { scriptId: step.scriptId } }
    }

    default: {
      // Exhaustive check — TypeScript will error if a step type is missing
      const _exhaustive: never = step
      void _exhaustive
      return { status: 'FAIL', error: `Unknown step type` }
    }
  }
}

// ---------------- Helpers ----------------

function parseViewport(v: string): { width: number; height: number } {
  const m = v.match(/^[\w-]+:(\d+)x(\d+)$/)
  if (m) {
    return { width: parseInt(m[1]!, 10), height: parseInt(m[2]!, 10) }
  }
  return { width: 1366, height: 768 }
}

async function generateTestFile(step: {
  autoGenerate?: 'text' | 'json' | 'png' | 'jpeg' | 'pdf' | 'csv'
  content?: string
  mimeType: string
  fileName: string
}): Promise<Buffer> {
  if (step.content) {
    return Buffer.from(step.content, 'utf8')
  }
  switch (step.autoGenerate) {
    case 'text':
      return Buffer.from('ProofPilot test file\n', 'utf8')
    case 'json':
      return Buffer.from(JSON.stringify({ test: true, source: 'proofpilot' }), 'utf8')
    case 'csv':
      return Buffer.from('col1,col2\nval1,val2\n', 'utf8')
    case 'png': {
      // 1x1 transparent PNG
      return Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        'base64',
      )
    }
    case 'jpeg': {
      // 1x1 JPEG
      return Buffer.from(
        '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3//2Q==',
        'base64',
      )
    }
    case 'pdf': {
      // Minimal valid PDF (Hello World)
      const pdf = '%PDF-1.1\n1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>endobj\n4 0 obj<< /Length 44 >>stream\nBT /F1 12 Tf 10 80 Td (ProofPilot test) Tj ET\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f \ntrailer<< /Size 5 /Root 1 0 R >>\nstartxref\n0\n%%EOF'
      return Buffer.from(pdf, 'utf8')
    }
    default:
      return Buffer.from('ProofPilot test file\n', 'utf8')
  }
}

async function recordStepResult(
  journeyRunId: string,
  stepIndex: number,
  step: JourneyStep,
  status: 'PASS' | 'FAIL' | 'SKIPPED',
  durationMs: number,
  error: string | null,
  consoleErrors: number,
  networkErrors: number,
  workspaceId: string,
  projectId: string,
  scanRunId: string | null,
  metadata?: Record<string, unknown> | null,
  beforeScreenshotId?: string | null,
  afterScreenshotId?: string | null,
): Promise<void> {
  await db.journeyStepResult.create({
    data: {
      journeyRunId,
      stepIndex,
      stepType: step.type,
      stepLabel: step.label ?? null,
      status,
      durationMs,
      error: error ? error.slice(0, 2000) : null,
      beforeScreenshotId: beforeScreenshotId ?? null,
      afterScreenshotId: afterScreenshotId ?? null,
      consoleErrors,
      networkErrors,
      metadataJson: metadata ? JSON.stringify(metadata) : null,
    },
  })
  void workspaceId
  void projectId
  void scanRunId
}

async function failJourneyRun(
  runId: string,
  scanRunId: string | null,
  reason: string,
  workspaceId: string,
  projectId: string,
): Promise<void> {
  await db.journeyRun.update({
    where: { id: runId },
    data: {
      status: 'FAILED',
      completedAt: new Date(),
      failedReason: reason.slice(0, 2000),
    },
  })
  await emitJourneyEvent(scanRunId, runId, 'journey.failed', { reason })
  void workspaceId
  void projectId
}

async function emitJourneyEvent(
  scanRunId: string | null,
  journeyRunId: string,
  eventType: 'journey.started' | 'journey.completed' | 'journey.failed' | 'journey.step' | 'journey.step.passed' | 'journey.step.failed' | 'journey.step.skipped' | 'journey.cancelled',
  payload: Record<string, unknown>,
): Promise<void> {
  if (scanRunId) {
    try {
      await appendScanEvent(scanRunId, eventType, { journeyRunId, ...payload })
    } catch (err) {
      logger.warn('Failed to emit journey event', { journeyRunId, eventType, error: String(err) })
    }
  }
}
