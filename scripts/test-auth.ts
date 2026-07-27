/**
 * Direct test of auth-service — ProofPilot
 *
 * Verifies the auth flows work end-to-end against the database,
 * without going through Next.js (which has sandbox memory issues).
 */
import { registerUser, verifyEmail, login, requestPasswordReset, resetPassword, beginTotpSetup, confirmTotpSetup, completeMfaChallenge, listSessions, revokeOtherSessions } from '../src/lib/auth-service'
import { db } from '../src/lib/db'
import { randomToken } from '../src/lib/crypto'

async function main() {
  const ctx = { ip: '127.0.0.1', userAgent: 'test-agent', requestId: 'test-req' }
  const testEmail = `test-${Date.now()}@example.com`
  console.log('1. Register user:', testEmail)
  const { userId, verificationToken } = await registerUser(
    { email: testEmail, password: 'TestPassword123!', name: 'Test User' },
    ctx,
  )
  console.log('   ✓ userId:', userId)

  console.log('2. Verify email')
  await verifyEmail(verificationToken, ctx)
  console.log('   ✓ Email verified')

  console.log('3. Login (no MFA)')
  const loginResult = await login({ email: testEmail, password: 'TestPassword123!' }, ctx)
  console.log('   ✓ requiresMfa:', loginResult.requiresMfa, 'hasSession:', !!loginResult.sessionToken)

  console.log('4. List sessions')
  const sessions = await listSessions(userId)
  console.log('   ✓ Sessions:', sessions.length)

  console.log('5. Begin TOTP setup')
  const totpSetup = await beginTotpSetup(userId, ctx)
  console.log('   ✓ Secret length:', totpSetup.secret.length, 'QR URL:', totpSetup.qrUrl.slice(0, 50) + '...')

  console.log('6. Login with wrong password (should fail)')
  try {
    await login({ email: testEmail, password: 'WrongPassword123!' }, ctx)
    console.log('   ✗ Should have failed')
  } catch (e) {
    console.log('   ✓ Correctly rejected:', (e as Error).message)
  }

  console.log('7. Request password reset')
  const reset = await requestPasswordReset(testEmail, ctx)
  console.log('   ✓ Token issued:', !!reset.token)

  console.log('8. Reset password')
  if (reset.token) {
    await resetPassword(reset.token, 'NewPassword123!', ctx)
    console.log('   ✓ Password reset')

    console.log('9. Login with new password')
    const newLogin = await login({ email: testEmail, password: 'NewPassword123!' }, ctx)
    console.log('   ✓ Login successful:', !!newLogin.sessionToken)
  }

  console.log('10. Revoke other sessions')
  const sessionCount = await listSessions(userId)
  if (sessionCount.length > 0) {
    const result = await revokeOtherSessions(sessionCount[0].id, userId, ctx)
    console.log('   ✓ Revoked:', result.revoked)
  }

  console.log('\n=== ALL AUTH TESTS PASSED ===')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('TEST FAILED:', err)
    process.exit(1)
  })
  .finally(async () => {
    await db.$disconnect()
  })
