// Test setup: ensure environment variables are valid before any module loads.
// bun test sets NODE_ENV=test which is not in our Zod schema.
process.env.NODE_ENV = process.env.NODE_ENV === 'test' ? 'development' : (process.env.NODE_ENV || 'development')
