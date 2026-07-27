/**
 * Environment validation — ProofPilot
 *
 * Parses and validates process.env with Zod. Refuses to start in production
 * with unsafe defaults. See SECURITY_MODEL.md §"Production safety".
 */
import { z } from 'zod'

const boolString = z
  .string()
  .transform((v) => v.toLowerCase() === 'true' || v === '1')

const schema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  APP_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  APP_NAME: z.string().default('ProofPilot'),
  APP_URL: z.string().url().default('http://localhost:3000'),
  APP_PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_PROVIDER: z.enum(['sqlite', 'postgresql']).default('sqlite'),
  DATABASE_URL: z.string().min(1),

  SESSION_COOKIE_NAME: z.string().default('__Host-proofpilot_session'),
  SESSION_ABSOLUTE_TTL_SECONDS: z.coerce.number().int().positive().default(432000),
  SESSION_IDLE_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
  SESSION_SECRET: z.string().min(16),
  CSRF_SECRET: z.string().min(16),

  PROOFPILOT_ENCRYPTION_KEY: z.string().min(20),
  MASTER_KEY_VERSION: z.coerce.number().int().positive().default(1),

  S3_ENDPOINT: z.string().default(''),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('proofpilot-artifacts'),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  S3_USE_SSL: boolString.default(false),
  S3_FORCE_PATH_STYLE: boolString.default(true),

  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  SMTP_FROM: z.string().default('noreply@proofpilot.local'),
  SMTP_FROM_NAME: z.string().default('ProofPilot'),
  MAILPIT_URL: z.string().default(''),

  GOOGLE_OAUTH_CLIENT_ID: z.string().default(''),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().default(''),
  GOOGLE_OAUTH_REDIRECT_URL: z.string().default(''),
  GITHUB_OAUTH_CLIENT_ID: z.string().default(''),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().default(''),
  GITHUB_OAUTH_REDIRECT_URL: z.string().default(''),

  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default(''),
  STRIPE_PRICE_FREE: z.string().default(''),
  STRIPE_PRICE_STARTER: z.string().default(''),
  STRIPE_PRICE_PRO: z.string().default(''),
  STRIPE_PRICE_AGENCY: z.string().default(''),
  STRIPE_DEV_MODE: boolString.default(true),

  AI_PROVIDER: z.enum(['glm', 'openai-compatible', 'mock']).default('glm'),
  AI_API_KEY: z.string().default(''),
  AI_BASE_URL: z.string().default(''),
  AI_MODEL: z.string().default('glm-4.6'),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  AI_MAX_TOKENS_PER_RUN: z.coerce.number().int().positive().default(20000),
  AI_DAILY_WORKSPACE_BUDGET_TOKENS: z.coerce.number().int().positive().default(100000),

  WORKER_PORT: z.coerce.number().int().positive().default(3003),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  WORKER_BROWSER_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  WORKER_MAX_PAGES_PER_RUN: z.coerce.number().int().positive().default(50),
  WORKER_MAX_RESPONSE_SIZE_BYTES: z.coerce.number().int().positive().default(5242880),
  PLAYWRIGHT_BROWSERS_PATH: z.string().default(''),

  SCAN_ALLOW_HTTP_LOCAL: boolString.default(false),
  SCAN_PRIVATE_NETWORK_OVERRIDE: boolString.default(false),
  SCAN_DEFAULT_VIEWPORTS: z.string().default('mobile:390x844,tablet:768x1024,laptop:1366x768,desktop:1920x1080'),
  SCAN_DEFAULT_MAX_PAGES: z.coerce.number().int().positive().default(20),
  SCAN_DEFAULT_MAX_DEPTH: z.coerce.number().int().positive().default(3),
  SCAN_DEFAULT_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_FORMAT: z.enum(['json', 'pretty']).default('pretty'),
  LOG_SERVICE_NAME: z.string().default('proofpilot-api'),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(''),
  OTEL_SERVICE_NAME: z.string().default('proofpilot'),
  OTEL_TRACES_ENABLED: boolString.default(false),

  FEATURE_AI_ENRICHMENT: boolString.default(true),
  FEATURE_PUBLIC_SCANS: boolString.default(true),
  FEATURE_FIREFOX_SCANNING: boolString.default(false),
  FEATURE_WEBKIT_SCANNING: boolString.default(false),
  FEATURE_VISUAL_REGRESSION: boolString.default(true),
  FEATURE_AGENCY_BRANDING: boolString.default(true),
  FEATURE_EXPERIMENTAL_INTEGRATIONS: boolString.default(false),
  FEATURE_PUBLIC_API_DOCS: boolString.default(false),

  RETENTION_ARTIFACT_DAYS: z.coerce.number().int().positive().default(30),
  RETENTION_AUDIT_LOG_DAYS: z.coerce.number().int().positive().default(365),
  RETENTION_SESSION_IDLE_DAYS: z.coerce.number().int().positive().default(1),

  CAPTCHA_PROVIDER: z.string().default(''),
  CAPTCHA_SITE_KEY: z.string().default(''),
  CAPTCHA_SECRET_KEY: z.string().default(''),

  RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_LOGIN_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_REGISTER_MAX: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_REGISTER_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_PASSWORD_RESET_MAX: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_PASSWORD_RESET_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_PUBLIC_SCAN_MAX: z.coerce.number().int().positive().default(3),
  RATE_LIMIT_PUBLIC_SCAN_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),
  RATE_LIMIT_GENERAL_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_GENERAL_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),

  DEV_DEMO_TARGET_URL: z.string().default('http://localhost:3000/demo-target'),
  DEV_ALLOW_LOCALHOST_TARGETS: boolString.default(true),
})

export type Env = z.infer<typeof schema>

let cached: Env | null = null

export function loadEnv(): Env {
  if (cached) return cached
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    console.error('Invalid environment configuration:')
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`)
    }
    throw new Error(`Environment validation failed: ${parsed.error.message}`)
  }
  const env = parsed.data
  validateProductionSafety(env)
  cached = env
  return env
}

function validateProductionSafety(env: Env): void {
  if (env.APP_ENV !== 'production' && env.NODE_ENV !== 'production') return
  const failures: string[] = []

  if (env.SESSION_SECRET.length < 32) {
    failures.push('SESSION_SECRET must be ≥ 32 chars in production')
  }
  if (env.APP_ENV === 'production' && !env.SESSION_COOKIE_NAME.startsWith('__Host-')) {
    failures.push('SESSION_COOKIE_NAME must use __Host- prefix in production')
  }
  if (env.CSRF_SECRET.length < 32) {
    failures.push('CSRF_SECRET must be ≥ 32 chars in production')
  }
  if (env.PROOFPILOT_ENCRYPTION_KEY.length < 24) {
    failures.push('PROOFPILOT_ENCRYPTION_KEY must be a 32-byte base64 string in production')
  }
  if (!env.APP_URL.startsWith('https://')) {
    failures.push('APP_URL must use HTTPS in production')
  }
  if (env.STRIPE_DEV_MODE && env.STRIPE_SECRET_KEY) {
    failures.push('STRIPE_DEV_MODE must be false when STRIPE_SECRET_KEY is set (live billing)')
  }
  if (env.SCAN_PRIVATE_NETWORK_OVERRIDE) {
    failures.push('SCAN_PRIVATE_NETWORK_OVERRIDE must be false in production')
  }
  if (env.S3_BUCKET === 'proofpilot-artifacts' && env.S3_ACCESS_KEY_ID === 'minioadmin') {
    failures.push('Default MinIO credentials must not be used in production')
  }
  if (failures.length > 0) {
    console.error('Production safety check failed:')
    for (const f of failures) console.error(`  - ${f}`)
    throw new Error(`Refusing to start in production with unsafe configuration: ${failures.join('; ')}`)
  }
}

export const env = loadEnv()
