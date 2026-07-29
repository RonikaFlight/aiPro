/**
 * Mock AI provider — ProofPilot
 *
 * Deterministic, offline provider. Used:
 *   - In tests (registered via `_setProviderForTest`).
 *   - As the automatic fallback when the configured provider is not configured
 *     (no keys / no config file) so the rest of the product keeps working.
 *
 * The mock never makes a network call. It produces responses keyed off the
 * taskType + a deterministic hash of the last user message, so tests can assert
 * on exact output. Structured requests are honoured by returning a canned JSON
 * object that satisfies common schemas (finding explanation, run summary, etc.).
 */
import type {
  AiProvider,
  AiProviderName,
  CompletionRequest,
  CompletionResponse,
  StructuredCompletionRequest,
  StructuredCompletionResponse,
  TokenUsage,
} from './types'
import { AiError } from './types'
import { buildRepairMessages, estimateTokens, extractJsonObject } from './shared'
import { createHash } from 'crypto'
import type { z } from 'zod'

export class MockAiProvider implements AiProvider {
  readonly name: AiProviderName = 'mock'
  /** Call log for test assertions. */
  readonly calls: Array<{
    taskType: string
    promptVersion: string
    kind: 'text' | 'structured'
    /** The messages sent to the provider (deep copy so later mutations don't affect the log). */
    messages: CompletionRequest['messages']
  }> = []

  isConfigured(): boolean {
    return true
  }

  /**
   * Deterministic 8-hex-char digest of the last user message. Lets tests vary
   * output by input without a real model.
   */
  private digest(messages: CompletionRequest['messages']): string {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    const seed = lastUser?.content ?? ''
    return createHash('sha256').update(seed).digest('hex').slice(0, 8)
  }

  private buildUsage(promptChars: number, completionChars: number): TokenUsage {
    const promptTokens = estimateTokens('x'.repeat(promptChars))
    const completionTokens = estimateTokens('x'.repeat(completionChars))
    return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.calls.push({
      taskType: req.taskType,
      promptVersion: req.promptVersion,
      kind: 'text',
      messages: req.messages.map((m) => ({ ...m })),
    })
    const digest = this.digest(req.messages)
    const content = this.cannedText(req.taskType, digest)
    return {
      content,
      finishReason: 'stop',
      usage: this.buildUsage(JSON.stringify(req.messages).length, content.length),
      model: 'mock-1.0',
      provider: 'mock',
    }
  }

  async completeStructured<T>(
    req: StructuredCompletionRequest,
    schema: z.ZodType<T>,
  ): Promise<StructuredCompletionResponse<T>> {
    this.calls.push({
      taskType: req.taskType,
      promptVersion: req.promptVersion,
      kind: 'structured',
      messages: req.messages.map((m) => ({ ...m })),
    })
    const digest = this.digest(req.messages)
    const candidate = this.cannedJson(req.taskType, digest, req.schemaName)

    // Validate against the schema; if it fails, attempt ONE repair retry with
    // the same candidate (the mock is deterministic, but the retry path mirrors
    // the real providers so cost/audit code is exercised identically).
    const parsed = schema.safeParse(candidate)
    let data: T
    let repaired = false
    if (parsed.success) {
      data = parsed.data
    } else {
      repaired = true
      // The mock's canned output is fixed; a repair cannot change it, so we
      // surface the validation error exactly as a real provider would.
      void buildRepairMessages(req.messages, JSON.stringify(candidate), parsed.error.message)
      const reparsed = schema.safeParse(candidate)
      if (!reparsed.success) {
        throw new AiError(
          'schema_validation',
          `Mock output failed schema ${req.schemaName}: ${parsed.error.message}`,
          { provider: 'mock', retryable: false },
        )
      }
      data = reparsed.data
    }

    const contentStr = JSON.stringify(candidate)
    return {
      data,
      usage: this.buildUsage(JSON.stringify(req.messages).length, contentStr.length),
      model: 'mock-1.0',
      provider: 'mock',
      repaired,
    }
  }

  // ---------------- Canned generators ----------------

  private cannedText(taskType: string, digest: string): string {
    switch (taskType) {
      case 'finding_explanation':
        return `This finding indicates a defect that affects users on the scanned page. The scanner detected the issue deterministically; the explanation below is generated to help non-technical stakeholders understand the impact. (ref ${digest})`
      case 'run_summary':
        return `The scan completed successfully. Key observations: a number of accessibility and responsive issues were detected. No runtime crashes were observed. (ref ${digest})`
      case 'remediation':
        return `Recommended fix: update the affected element to meet the expected semantics, then re-run the scan to confirm the finding is resolved. (ref ${digest})`
      case 'business_impact':
        return `Likely business impact: USER_EXPERIENCE. The defect may reduce conversion for affected visitors. (ref ${digest})`
      case 'client_report':
        return `Delivery readiness: NEEDS_WORK. A small number of issues must be addressed before this build is ready for client sign-off. (ref ${digest})`
      default:
        return `Mock completion for task ${taskType}. (ref ${digest})`
    }
  }

  /**
   * Produce a JSON object that satisfies common Phase 8 schemas. The shape is
   * deliberately permissive (extra keys are fine — Zod schemas should use
   * `.strict()` or `.passthrough()` as needed and strip extras themselves).
   */
  private cannedJson(taskType: string, digest: string, schemaName: string): Record<string, unknown> {
    switch (taskType) {
      case 'finding_explanation':
        return {
          explanation: `The scanner flagged this element because it fails the configured check. (ref ${digest})`,
          userImpact: 'Visitors using assistive technology may be unable to complete the action.',
          rootCause: 'Missing semantic attribute on the target element.',
        }
      case 'run_summary':
        return {
          executiveSummary: `Scan completed with a mix of accessibility and responsive findings. (ref ${digest})`,
          topIssues: [
            { category: 'ACCESSIBILITY', count: 2, severity: 'CRITICAL' },
            { category: 'RESPONSIVE', count: 1, severity: 'MAJOR' },
          ],
          deliveryReadiness: 'NEEDS_WORK',
          recommendation: 'Fix the critical accessibility issues before client delivery.',
        }
      case 'business_impact':
        return {
          impacts: ['USER_EXPERIENCE'],
          rationale: 'The defect affects a primary interaction path.',
          confidence: 'MEDIUM',
        }
      case 'remediation':
        return {
          summary: 'Add the missing attribute and re-test.',
          steps: [
            'Locate the element matching the selector.',
            'Add the required semantic attribute.',
            'Re-run the scan to confirm resolution.',
          ],
          estimatedEffort: 'LOW',
        }
      case 'journey_proposal':
        return {
          name: 'Critical path smoke test',
          entryUrl: '/',
          steps: [
            { type: 'NAVIGATE', url: '/', label: 'Open home page' },
            { type: 'ASSERT_VISIBLE', selector: 'main', label: 'Main content renders' },
          ],
          rationale: 'Covers the primary entry point and confirms the shell renders.',
        }
      case 'semantic_grouping':
        return {
          groups: [
            {
              groupId: `grp-${digest}`,
              label: 'Accessibility — missing labels',
              findingIds: ['finding-sample-1'],
              sharedRootCause: 'Form controls lack associated label elements.',
            },
          ],
        }
      case 'client_report':
        return {
          clientSummary: `The application was tested across multiple viewports. A handful of issues were found and are listed in the report. (ref ${digest})`,
          deliveryReadiness: 'NEEDS_WORK',
          positiveNotes: ['No runtime crashes were observed.', 'Pages load within acceptable thresholds.'],
          attentionItems: ['Resolve critical accessibility findings before sign-off.'],
        }
      default:
        return { ok: true, taskType, schemaName, ref: digest }
    }
  }
}

/**
 * Test-only escape hatch: parse a canned raw JSON string the way the real
 * providers do, so the extraction helper is exercised under Mock too.
 */
export function parseMockJson(raw: string): unknown {
  return extractJsonObject(raw)
}
