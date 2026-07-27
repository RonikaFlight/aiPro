/**
 * Phase 8 — AI provider abstraction standalone verification
 *
 * Exercises the provider abstraction, Mock/GLM/OpenAI-compatible adapters, the
 * registry fallback logic, JSON extraction, and LLM usage recording — directly,
 * without spinning up Next.js or making real network calls.
 *
 * Run: `bun run scripts/test-phase8-ai-standalone.ts`
 */
import { z } from 'zod'
import { db, disconnectDb } from '../src/lib/db'
import { env } from '../src/lib/env'
import {
  MockAiProvider,
  GlmAiProvider,
  OpenAiCompatibleProvider,
  getAiProvider,
  getConfiguredProviderName,
  isRealAiProviderActive,
  _setProviderForTest,
  _resetProviderForTest,
  recordLlmUsage,
  getRunTokenUsage,
  getWorkspaceDailyTokenUsage,
  extractJsonObject,
  estimateTokens,
  AiError,
  type AiProvider,
} from '../src/lib/ai'

let testsPassed = 0
let testsFailed = 0

function assert(condition: boolean, message: string): void {
  if (condition) {
    testsPassed++
    console.log(`  ✓ ${message}`)
  } else {
    testsFailed++
    console.error(`  ✗ ${message}`)
  }
}

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  console.log(`\n${name}`)
  try {
    await fn()
  } catch (err) {
    testsFailed++
    console.error(`  ✗ threw unexpectedly: ${(err as Error).message}`)
    console.error(err)
  }
}

// ---------------- 1. extractJsonObject ----------------

await test('extractJsonObject handles clean / fenced / prose / rejects garbage', () => {
  assert((extractJsonObject('{"a":1}') as { a: number }).a === 1, 'clean JSON object parsed')
  const fenced = 'Here is the result:\n```json\n{"b": 2, "c": "x"}\n```\nDone.'
  assert((extractJsonObject(fenced) as { b: number }).b === 2, 'fenced JSON parsed')
  const prose = 'Sure! {"deep": {"nested": [1,2,3]}, "ok": true} hope that helps.'
  assert(
    (extractJsonObject(prose) as { deep: { nested: number[] } }).deep.nested.length === 3,
    'prose-wrapped JSON parsed with bracket matching',
  )
  try {
    extractJsonObject('not json at all')
    assert(false, 'should have thrown on non-json')
  } catch (e) {
    assert(e instanceof AiError && e.kind === 'invalid_response', 'non-json throws AiError invalid_response')
  }
  try {
    extractJsonObject('{ unbalanced')
    assert(false, 'should have thrown on unbalanced')
  } catch (e) {
    assert(e instanceof AiError, 'unbalanced throws')
  }
  // String with brace inside should not confuse bracket matcher.
  const tricky = '{"msg": "has } inside string", "n": 1}'
  assert((extractJsonObject(tricky) as { n: number }).n === 1, 'brace inside string handled')
})

// ---------------- 2. estimateTokens ----------------

await test('estimateTokens is positive + monotonic', () => {
  assert(estimateTokens('') === 0, 'empty string → 0 tokens')
  assert(estimateTokens('hello') >= 1, 'short string ≥ 1 token')
  assert(estimateTokens('a'.repeat(400)) === 100, '400 chars → ~100 tokens')
  assert(estimateTokens('a'.repeat(401)) === 101, '401 chars → ~101 tokens')
})

// ---------------- 3. MockAiProvider ----------------

await test('MockAiProvider is always configured + deterministic', async () => {
  const mock = new MockAiProvider()
  assert(mock.isConfigured() === true, 'isConfigured() true')
  assert(mock.name === 'mock', 'name is mock')

  const r1 = await mock.complete({
    messages: [
      { role: 'system', content: 'You explain findings.' },
      { role: 'user', content: 'Explain finding ABC-123' },
    ],
    taskType: 'finding_explanation',
    promptVersion: 'finding_explanation.v1',
  })
  const r2 = await mock.complete({
    messages: [
      { role: 'system', content: 'You explain findings.' },
      { role: 'user', content: 'Explain finding ABC-123' },
    ],
    taskType: 'finding_explanation',
    promptVersion: 'finding_explanation.v1',
  })
  assert(r1.content === r2.content, 'same input → same output (deterministic)')
  assert(r1.provider === 'mock' && r1.model === 'mock-1.0', 'provider+model tagged')
  assert(r1.usage.totalTokens > 0, 'usage reported')
  assert(r1.finishReason === 'stop', 'finishReason stop')
  assert(mock.calls.length === 2, 'call log recorded both calls')
  assert(
    mock.calls[0].taskType === 'finding_explanation' &&
      mock.calls[0].promptVersion === 'finding_explanation.v1',
    'call log captures taskType + promptVersion',
  )
})

await test('MockAiProvider completeStructured validates against Zod schema', async () => {
  const mock = new MockAiProvider()
  const schema = z.object({
    explanation: z.string(),
    userImpact: z.string(),
    rootCause: z.string(),
  })
  const r = await mock.completeStructured(
    {
      messages: [
        { role: 'system', content: 'Reply with JSON {explanation,userImpact,rootCause}.' },
        { role: 'user', content: 'Finding: missing alt' },
      ],
      taskType: 'finding_explanation',
      promptVersion: 'finding_explanation.v1',
      schema,
      schemaName: 'FindingExplanation',
    },
    schema,
  )
  assert(typeof r.data.explanation === 'string', 'explanation field present')
  assert(typeof r.data.userImpact === 'string', 'userImpact field present')
  assert(typeof r.data.rootCause === 'string', 'rootCause field present')
  assert(r.usage.totalTokens > 0, 'structured usage reported')
  assert(r.provider === 'mock', 'structured provider tagged')
})

await test('MockAiProvider completeStructured throws on schema mismatch', async () => {
  const mock = new MockAiProvider()
  // Schema demands a field the mock's canned output does not provide.
  const schema = z.object({
    thisFieldDoesNotExist: z.string(),
  })
  try {
    await mock.completeStructured(
      {
        messages: [{ role: 'user', content: 'x' }],
        taskType: 'general',
        promptVersion: 'general.v1',
        schema,
        schemaName: 'Impossible',
      },
      schema,
    )
    assert(false, 'should have thrown schema_validation')
  } catch (e) {
    assert(
      e instanceof AiError && e.kind === 'schema_validation',
      'schema mismatch → AiError schema_validation',
    )
  }
})

// ---------------- 4. GlmAiProvider (not configured in sandbox) ----------------

await test('GlmAiProvider reports not-configured + refuses calls without keys', async () => {
  const glm = new GlmAiProvider()
  // In the sandbox neither .z-ai-config nor AI_API_KEY/AI_BASE_URL are set.
  const hasConfigFile =
    typeof env.AI_API_KEY === 'string' && env.AI_API_KEY.length > 0 && env.AI_BASE_URL.length > 0
  assert(
    glm.isConfigured() === hasConfigFile,
    `isConfigured()=${glm.isConfigured()} (expected ${hasConfigFile} in current env)`,
  )
  if (!hasConfigFile) {
    try {
      await glm.complete({
        messages: [{ role: 'user', content: 'hi' }],
        taskType: 'general',
        promptVersion: 'general.v1',
      })
      assert(false, 'should have thrown not_configured')
    } catch (e) {
      assert(
        e instanceof AiError && e.kind === 'not_configured',
        'no keys → AiError not_configured',
      )
    }
  }
})

// ---------------- 5. OpenAiCompatibleProvider (not configured in sandbox) ----------------

await test('OpenAiCompatibleProvider reports not-configured without env keys', async () => {
  const oai = new OpenAiCompatibleProvider()
  const expected = !!env.AI_API_KEY && !!env.AI_BASE_URL
  assert(oai.isConfigured() === expected, `isConfigured()=${oai.isConfigured()} expected ${expected}`)
  if (!expected) {
    try {
      await oai.complete({
        messages: [{ role: 'user', content: 'hi' }],
        taskType: 'general',
        promptVersion: 'general.v1',
      })
      assert(false, 'should have thrown not_configured')
    } catch (e) {
      assert(
        e instanceof AiError && e.kind === 'not_configured',
        'no keys → AiError not_configured',
      )
    }
  }
})

// ---------------- 6. Registry + fallback ----------------

await test('Registry returns Mock when AI_PROVIDER=mock', () => {
  _resetProviderForTest()
  const original = env.AI_PROVIDER
  ;(env as { AI_PROVIDER: string }).AI_PROVIDER = 'mock'
  try {
    const p = getAiProvider()
    assert(p.name === 'mock', 'AI_PROVIDER=mock → Mock provider')
    assert(getConfiguredProviderName() === 'mock', 'getConfiguredProviderName reflects env')
    assert(isRealAiProviderActive() === true, 'isRealAiProviderActive true for explicit mock')
  } finally {
    ;(env as { AI_PROVIDER: string }).AI_PROVIDER = original
    _resetProviderForTest()
  }
})

await test('Registry falls back to Mock when configured provider is not ready', () => {
  _resetProviderForTest()
  const original = env.AI_PROVIDER
  // Force glm, which is not configured in the sandbox.
  ;(env as { AI_PROVIDER: string }).AI_PROVIDER = 'glm'
  try {
    const p = getAiProvider()
    assert(p.name === 'mock', 'glm-not-configured → Mock fallback')
    assert(getConfiguredProviderName() === 'glm', 'getConfiguredProviderName still says glm')
    assert(isRealAiProviderActive() === false, 'isRealAiProviderActive false under fallback')
  } finally {
    ;(env as { AI_PROVIDER: string }).AI_PROVIDER = original
    _resetProviderForTest()
  }
})

await test('Registry test override hook works', () => {
  _resetProviderForTest()
  const fake: AiProvider = {
    name: 'mock',
    isConfigured: () => true,
    complete: async () => ({
      content: 'injected',
      finishReason: 'stop',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: 'fake',
      provider: 'mock',
    }),
    completeStructured: async () => ({
      data: { ok: true },
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: 'fake',
      provider: 'mock',
      repaired: false,
    }),
  } as unknown as AiProvider
  _setProviderForTest(fake)
  const p = getAiProvider()
  assert(p === fake, 'override is returned by getAiProvider')
  _resetProviderForTest()
  const p2 = getAiProvider()
  assert(p2 !== fake, 'override cleared after reset')
})

// ---------------- 7. LLM usage recording ----------------

await test('recordLlmUsage persists a row + sums are correct', async () => {
  // Use the first workspace from the seed (or null if none).
  const ws = await db.workspace.findFirst({})
  const workspaceId = ws?.id ?? null

  const ok = await recordLlmUsage({
    workspaceId,
    provider: 'mock',
    model: 'mock-1.0',
    usage: { promptTokens: 120, completionTokens: 80, totalTokens: 200 },
    taskType: 'finding_explanation',
    promptVersion: 'finding_explanation.v1',
  })
  assert(ok === true, 'recordLlmUsage returned true')

  if (workspaceId) {
    const daily = await getWorkspaceDailyTokenUsage(workspaceId)
    assert(daily >= 200, `workspace daily usage ≥ 200 (got ${daily})`)
  }

  // runId not supplied (nullable); getRunTokenUsage with a synthetic id returns 0
  // because no rows match — verifies the sum doesn't crash on empty result.
  const emptyRun = await getRunTokenUsage('nonexistent-run-id')
  assert(emptyRun === 0, 'getRunTokenUsage on missing run → 0')
})

await test('recordLlmUsage swallows DB errors (best-effort)', async () => {
  // Pass an invalid workspaceId (FK violation) — should not throw.
  const ok = await recordLlmUsage({
    workspaceId: 'nonexistent-workspace-id',
    provider: 'mock',
    model: 'mock-1.0',
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    taskType: 'general',
    promptVersion: 'general.v1',
  })
  assert(ok === false, 'FK violation → returns false (not throw)')
})

// ---------------- Summary ----------------

console.log(`\n${'='.repeat(60)}`)
console.log(`Phase 8 AI provider abstraction: ${testsPassed} passed, ${testsFailed} failed`)
console.log(`${'='.repeat(60)}`)

await disconnectDb()
process.exit(testsFailed === 0 ? 0 : 1)
