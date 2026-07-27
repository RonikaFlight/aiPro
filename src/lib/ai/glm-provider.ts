/**
 * Z.ai GLM provider — ProofPilot
 *
 * Uses the `z-ai-web-dev-sdk` package (the platform's in-house SDK). The SDK
 * reads its config from a `.z-ai-config` JSON file (project / home / /etc).
 * To keep deployment driven by env vars (AI_API_KEY / AI_BASE_URL), this
 * provider writes a `.z-ai-config` file from env on first init when the file is
 * absent but the env vars are present. The write is logged and idempotent.
 *
 * Structured output: GLM accepts OpenAI-style `response_format:
 * { type: 'json_object' }`. The system prompt must still instruct the model to
 * emit JSON; we then Zod-validate and retry once on failure.
 */
import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import type {
  AiProvider,
  AiProviderName,
  CompletionRequest,
  CompletionResponse,
  StructuredCompletionRequest,
  StructuredCompletionResponse,
} from './types'
import { AiError } from './types'
import { buildRepairMessages, extractJsonObject, withTimeout } from './shared'
import { env } from '../env'
import { logger } from '../logger'
import type { z } from 'zod'

// Dynamically import the SDK so that environments without the package (or where
// it fails to load because no config exists yet) don't crash at import time.
type ZaiInstance = {
  chat: {
    completions: {
      create: (body: Record<string, unknown>) => Promise<unknown>
    }
  }
}
type ZaiStatic = { create: () => Promise<ZaiInstance> }
type ZaiModule = { default: ZaiStatic }

let sdkPromise: Promise<ZaiInstance> | null = null
let configWritten = false

export class GlmAiProvider implements AiProvider {
  readonly name: AiProviderName = 'glm'

  isConfigured(): boolean {
    return (
      existsSync(join(process.cwd(), '.z-ai-config')) ||
      (!!env.AI_API_KEY && !!env.AI_BASE_URL)
    )
  }

  /**
   * Ensure a `.z-ai-config` exists. If env vars are set but the file is missing,
   * write it once (idempotent). If neither exists, throw not_configured so the
   * registry can fall back to Mock.
   */
  private async ensureConfig(): Promise<void> {
    const configPath = join(process.cwd(), '.z-ai-config')
    if (existsSync(configPath)) return
    if (!env.AI_API_KEY || !env.AI_BASE_URL) {
      throw new AiError(
        'not_configured',
        'GLM provider not configured: no .z-ai-config file and no AI_API_KEY/AI_BASE_URL env vars',
        { provider: 'glm', retryable: false },
      )
    }
    if (!configWritten) {
      writeFileSync(
        configPath,
        JSON.stringify({ baseUrl: env.AI_BASE_URL, apiKey: env.AI_API_KEY }),
        { mode: 0o600 },
      )
      configWritten = true
      logger.warn('Wrote .z-ai-config from AI_API_KEY/AI_BASE_URL env vars', {
        path: configPath,
        baseUrl: env.AI_BASE_URL,
      })
    }
  }

  private async getClient(): Promise<ZaiInstance> {
    if (!sdkPromise) {
      sdkPromise = (async () => {
        await this.ensureConfig()
        // Late import so a missing/unusable SDK never breaks the module.
        const mod = (await import('z-ai-web-dev-sdk')) as unknown as ZaiModule
        return mod.default.create()
      })().catch((err) => {
        // Reset so a later retry can attempt init again.
        sdkPromise = null
        throw new AiError(
          'not_configured',
          `Failed to initialise z-ai-web-dev-sdk: ${(err as Error).message}`,
          { provider: 'glm', retryable: false, cause: err },
        )
      })
    }
    return sdkPromise
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const client = await this.getClient()
    const body: Record<string, unknown> = {
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      model: req.model ?? env.AI_MODEL,
      thinking: { type: 'disabled' },
    }
    if (typeof req.temperature === 'number') body.temperature = req.temperature
    if (typeof req.maxTokens === 'number') body.max_tokens = req.maxTokens

    const timeoutMs = req.timeoutMs ?? env.AI_TIMEOUT_MS
    const raw = (await withTimeout(client.chat.completions.create(body), timeoutMs, 'glm')) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
      model?: string
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
    }

    const content = raw?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || content.length === 0) {
      throw new AiError('invalid_response', 'GLM returned no content', {
        provider: 'glm',
        retryable: true,
      })
    }
    const promptTokens = raw?.usage?.prompt_tokens ?? 0
    const completionTokens = raw?.usage?.completion_tokens ?? 0
    return {
      content,
      finishReason: this.mapFinishReason(raw?.choices?.[0]?.finish_reason),
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: raw?.usage?.total_tokens ?? promptTokens + completionTokens,
      },
      model: raw?.model ?? env.AI_MODEL,
      provider: 'glm',
    }
  }

  async completeStructured<T>(
    req: StructuredCompletionRequest,
    schema: z.ZodType<T>,
  ): Promise<StructuredCompletionResponse<T>> {
    const baseBody: Record<string, unknown> = {
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      model: req.model ?? env.AI_MODEL,
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
    }
    if (typeof req.temperature === 'number') baseBody.temperature = req.temperature
    if (typeof req.maxTokens === 'number') baseBody.max_tokens = req.maxTokens

    const client = await this.getClient()
    const timeoutMs = req.timeoutMs ?? env.AI_TIMEOUT_MS

    // First attempt.
    const raw1 = (await withTimeout(client.chat.completions.create(baseBody), timeoutMs, 'glm')) as {
      choices?: Array<{ message?: { content?: string } }>
      model?: string
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
    }
    const content1 = raw1?.choices?.[0]?.message?.content ?? ''
    let parsed1: unknown
    try {
      parsed1 = extractJsonObject(content1)
    } catch (e) {
      // If extraction fails outright, go straight to repair.
      parsed1 = undefined
      void e
    }

    const result1 = parsed1 === undefined ? null : schema.safeParse(parsed1)
    if (result1 && result1.success) {
      const promptTokens = raw1?.usage?.prompt_tokens ?? 0
      const completionTokens = raw1?.usage?.completion_tokens ?? 0
      return {
        data: result1.data,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: raw1?.usage?.total_tokens ?? promptTokens + completionTokens,
        },
        model: raw1?.model ?? env.AI_MODEL,
        provider: 'glm',
        repaired: false,
      }
    }

    // Repair retry: send the failed output back + the validation error.
    const errorMsg =
      result1 && !result1.success
        ? result1.error.message
        : 'Response was not valid JSON'
    const repairBody = {
      ...baseBody,
      messages: buildRepairMessages(
        req.messages.map((m) => ({ role: m.role, content: m.content })),
        content1,
        errorMsg,
      ),
    }
    const raw2 = (await withTimeout(client.chat.completions.create(repairBody), timeoutMs, 'glm')) as {
      choices?: Array<{ message?: { content?: string } }>
      model?: string
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
    }
    const content2 = raw2?.choices?.[0]?.message?.content ?? ''
    const parsed2 = extractJsonObject(content2)
    const result2 = schema.safeParse(parsed2)
    if (!result2.success) {
      throw new AiError(
        'schema_validation',
        `GLM output failed schema ${req.schemaName} after repair: ${result2.error.message}`,
        { provider: 'glm', retryable: false },
      )
    }

    const promptTokens =
      (raw1?.usage?.prompt_tokens ?? 0) + (raw2?.usage?.prompt_tokens ?? 0)
    const completionTokens =
      (raw1?.usage?.completion_tokens ?? 0) + (raw2?.usage?.completion_tokens ?? 0)
    return {
      data: result2.data,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      model: raw2?.model ?? env.AI_MODEL,
      provider: 'glm',
      repaired: true,
    }
  }

  private mapFinishReason(
    raw: string | undefined,
  ): CompletionResponse['finishReason'] {
    switch (raw) {
      case 'stop':
        return 'stop'
      case 'length':
        return 'length'
      case 'content_filter':
        return 'content_filter'
      case 'tool_calls':
        return 'tool_calls'
      default:
        return 'unknown'
    }
  }
}
