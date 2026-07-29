/**
 * Test environment setup — must be loaded before any source imports.
 *
 * Usage: bun test --preload tests/isolation/test-env.ts tests/isolation/...
 *
 * Sets minimal required environment variables for running tests
 * against a local SQLite database.
 */
process.env.NODE_ENV = 'development'
process.env.APP_ENV = 'development'
process.env.DATABASE_URL = 'file:/home/z/my-project/db/custom.db'
process.env.SESSION_SECRET = 'test-session-secret-at-least-16-chars'
process.env.CSRF_SECRET = 'test-csrf-secret-at-least-16-chars'
process.env.PROOFPILOT_ENCRYPTION_KEY = 'dGVzdC1lbmNyeXB0aW9uLWtleS0zMmJ5dGVz'
