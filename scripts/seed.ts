/**
 * Seed runner — `npm run seed` or `npx tsx scripts/seed.ts`
 */
import { runSeed } from '../src/lib/seed'
import { disconnectDb } from '../src/lib/db'

runSeed()
  .then(async () => {
    await disconnectDb()
    process.exit(0)
  })
  .catch(async (err) => {
    console.error('Seed failed:', err)
    await disconnectDb()
    process.exit(1)
  })
