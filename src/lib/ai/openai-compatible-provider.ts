/**
 * OpenAI-compatible provider — ProofPilot
 *
 * Talks to any endpoint that implements the OpenAI Chat Completions API
 * (POST {baseUrl}/chat/completions, Authorization: Bearer {apiKey}). This is
 * used when AI_PROVIDER=openai-compatible — e.g. pointing at Azure OpenAI,
 * Together, Anyscale, a self-hosted vLLM, or any other compatible gateway.
 *
 * Config comes from env: AI_BASE_URL (must include /v1), AI_API_KEY, AI_MODEL.
 * Structured output uses `response_format: { type: 'json_object' }` plus
 * Zod validation with one repair retry, identical to the GLM provider.
 */
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
import type { z } from 'zod'

interface OpenAiChoice {
  message?: { content?: string }
  finish_reason?: string
}
interface OpenAiResponse {
  choices?: OpenAiChoice[]
  model?: string
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  error?: { message?: string; type?: string; code?: string }
}

export class OpenAiCompatibleProvider implements AiProvider {
  readonly name: AiProviderName = 'openai-compatible'

  isConfigured(): boolean {
    return !!env.AI_API_KEY && !!env.AI_BASE_URL
  }

  private get endpoint(): string {
    // AI_BASE_URL must include the version prefix (e.g. https://api.openai.com/v1).
    const base = env.AI_BASE_URL.replace(/\/+$/, '')
    return `${base}/chat/completions`
  }

  private buildBody(req: CompletionRequest, jsonMode: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      model: req.model ?? env.AI_MODEL,
    }
    if (typeof req.temperature === 'number') body.temperature = req.temperature
    if (typeof req.maxTokens === 'number') body.max_tokens = req.maxTokens
    if (jsonMode) body.response_format = { type: 'json_object' }
    return body
  }

  private async call(
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<OpenAiResponse> {
    if (!this.isConfigured()) {
      throw new AiError(
        'not_configured',
        'OpenAI-compatible provider requires AI_API_KEY and AI_BASE_URL',
        { provider: 'openai-compatible', retryable: false },
      )
    }
    const fetchPromise = fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.AI_API_KEY}`,
      },
      body: JSON.stringify(body),
    }).then(async (res) => {
      const text = await res.text()
      let json: OpenAiResponse
      try {
        json = JSON.parse(text) as OpenAiResponse
      } catch {
        throw new AiError(
          'invalid_response',
          `OpenAI-compatible endpoint returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`,
          { provider: 'openai-compatible', retryable: false },
        )
      }
      if (!res.ok) {
        const msg = json.error?.message ?? `HTTP ${res.status}`
        const kind = res.status === 429 ? 'rate_limited' : 'provider_error'
        throw new AiError(kind, `OpenAI-compatible error: ${msg}`, {
          provider: 'openai-compatible',
          retryable: res.status >= 500 || res.status === 429,
        })
      }
      return json
    })

    return withTimeout(fetchPromise, timeoutMs, 'openai-compatible')
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const body = this.buildBody(req, false)
    const raw = await this.call(body, req.timeoutMs ?? env.AI_TIMEOUT_MS)
    const content = raw?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || content.length === 0) {
      throw new AiError('invalid_response', 'OpenAI-compatible endpoint returned no content', {
        provider: 'openai-compatible',
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
      provider: 'openai-compatible',
    }
  }

  async completeStructured<T>(
    req: StructuredCompletionRequest,
    schema: z.ZodType<T>,
  ): Promise<StructuredCompletionResponse<T>> {
    const timeoutMs = req.timeoutMs ?? env.AI_TIMEOUT_MS
    const body1 = this.buildBody(req, true)
    const raw1 = await this.call(body1, timeoutMs)
    const content1 = raw1?.choices?.[0]?.message?.content ?? ''

    let parsed1: unknown
    try {
      parsed1 = extractJsonObject(content1)
    } catch {
      parsed1 = undefined
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
        provider: 'openai-compatible',
        repaired: false,
      }
    }

    // Repair retry.
    const errorMsg =
      result1 && !result1.success ? result1.error.message : 'Response was not valid JSON'
    const body2 = {
      ...body1,
      messages: buildRepairMessages(
        req.messages.map((m) => ({ role: m.role, content: m.content })),
        content1,
        errorMsg,
      ),
    }
    const raw2 = await this.call(body2, timeoutMs)
    const content2 = raw2?.choices?.[0]?.message?.content ?? ''
    const parsed2 = extractJsonObject(content2)
    const result2 = schema.safeParse(parsed2)
    if (!result2.success) {
      throw new AiError(
        'schema_validation',
        `OpenAI-compatible output failed schema ${req.schemaName} after repair: ${result2.error.message}`,
        { provider: 'openai-compatible', retryable: false },
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
      provider: 'openai-compatible',
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
