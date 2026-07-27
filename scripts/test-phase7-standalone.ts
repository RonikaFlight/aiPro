/**
 * Phase 7 — Journeys standalone verification
 *
 * Exercises the journey service, project-secrets vault, and safe-action policy
 * directly without spinning up Next.js + worker + Chrome (which would OOM the
 * 4GB sandbox). Same approach as Phase 5/6 standalone tests.
 *
 * Run: `bun run scripts/test-phase7-standalone.ts`
 */
import { db } from '../src/lib/db'
import {
  createJourney,
  getJourney,
  updateJourney,
  listJourneys,
  listJourneyVersions,
  getJourneyVersion,
  rollbackJourney,
  deleteJourney,
  validateJourney,
} from '../src/lib/journey-service'
import {
  setSecret,
  listSecrets,
  resolveSecret,
  resolveSecretsForSteps,
  extractSecretKeys,
} from '../src/lib/project-secrets'
import {
  validateStepsAgainstPolicy,
  isDestructiveSelector,
  isDestructiveUrl,
  isDestructiveText,
  minimumModeForStep,
} from '../src/lib/journey-policy'
import {
  JourneyStepsSchema,
  parseSteps,
  serializeSteps,
  isStepAllowedForMode,
  type JourneyStep,
} from '../src/lib/journey-types'
import { createJourneyRun } from '../src/lib/journey-run-service'

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

async function main() {
  console.log('Phase 7 — Journeys standalone verification\n')

  // Use the demo workspace + project seeded by `bun run seed`
  const workspace = await db.workspace.findFirst({
    where: { slug: 'demo-agency' },
    include: { members: true },
  })
  if (!workspace) {
    console.error('Demo workspace not found — run `bun run seed` first.')
    process.exit(1)
  }
  const owner = workspace.members.find((m) => m.role === 'OWNER')
  if (!owner) {
    console.error('Demo workspace has no OWNER member.')
    process.exit(1)
  }
  const project = await db.project.findFirst({
    where: { workspaceId: workspace.id, status: 'ACTIVE' },
  })
  if (!project) {
    console.error('Demo project not found — run `bun run seed` first.')
    process.exit(1)
  }
  const ctx = { ip: '127.0.0.1', userAgent: 'test-script', requestId: 'phase7-test' }

  // ============ Test 1: Step type validation ============
  console.log('1. Step type validation (Zod schemas)')

  const validSteps: JourneyStep[] = [
    { type: 'NAVIGATE', url: 'https://example.com/' },
    { type: 'CLICK', selector: 'button#submit' },
    { type: 'TYPE', selector: 'input[name=email]', text: 'test@example.com' },
    { type: 'TYPE', selector: 'input[name=password]', secretRef: '{{secret.PASSWORD}}' },
    { type: 'SELECT', selector: 'select#country', value: 'US' },
    { type: 'CHECK', selector: 'input[name=agree]' },
    { type: 'UNCHECK', selector: 'input[name=newsletter]' },
    { type: 'UPLOAD_TEST_FILE', selector: 'input[type=file]', fileName: 'test.txt', mimeType: 'text/plain', content: 'hello' },
    { type: 'WAIT_FOR_SELECTOR', selector: '.success' },
    { type: 'WAIT_FOR_TIMEOUT', ms: 500 },
    { type: 'WAIT_FOR_URL', url: '/dashboard' },
    { type: 'ASSERT_VISIBLE', selector: '.welcome' },
    { type: 'ASSERT_HIDDEN', selector: '.loading' },
    { type: 'ASSERT_TEXT', selector: 'h1', text: 'Welcome' },
    { type: 'ASSERT_URL', url: '/dashboard' },
    { type: 'ASSERT_TITLE', text: 'Dashboard' },
    { type: 'SCREENSHOT' },
    { type: 'CUSTOM_SAFE_SCRIPT', scriptId: 'scroll_to_top' },
  ]
  const parsed = JourneyStepsSchema.safeParse(validSteps)
  assert(parsed.success, `18 valid steps parse successfully (${parsed.success ? '' : parsed.error.message})`)

  // Invalid: empty steps
  const emptyResult = JourneyStepsSchema.safeParse([])
  assert(!emptyResult.success, 'Empty steps array is rejected')

  // Invalid: TYPE with both text and secretRef
  const badType = JourneyStepsSchema.safeParse([
    { type: 'TYPE', selector: 'input', text: 'foo', secretRef: '{{secret.X}}' },
  ])
  assert(!badType.success, 'TYPE with both text + secretRef is rejected')

  // Invalid: TYPE with neither
  const badType2 = JourneyStepsSchema.safeParse([
    { type: 'TYPE', selector: 'input' },
  ])
  assert(!badType2.success, 'TYPE with neither text nor secretRef is rejected')

  // Invalid: selector with javascript: URI
  const badSelector = JourneyStepsSchema.safeParse([
    { type: 'CLICK', selector: 'javascript:alert(1)' },
  ])
  assert(!badSelector.success, 'Selector containing javascript: is rejected')

  // Invalid: secretRef with bad format
  const badSecret = JourneyStepsSchema.safeParse([
    { type: 'TYPE', selector: 'input', secretRef: 'password' }, // missing {{secret.}} wrapper
  ])
  assert(!badSecret.success, 'Malformed secret reference is rejected')

  // Invalid: secretRef with lowercase name
  const badSecret2 = JourneyStepsSchema.safeParse([
    { type: 'TYPE', selector: 'input', secretRef: '{{secret.password}}' },
  ])
  assert(!badSecret2.success, 'Lowercase secret name is rejected (must be [A-Z0-9_]+)')

  // Invalid: selector > 200 chars
  const longSelector = JourneyStepsSchema.safeParse([
    { type: 'CLICK', selector: 'a'.repeat(201) },
  ])
  assert(!longSelector.success, 'Selector > 200 chars is rejected')

  // Invalid: > 100 steps
  const tooManySteps = JourneyStepsSchema.safeParse(
    Array.from({ length: 101 }, () => ({ type: 'WAIT_FOR_TIMEOUT', ms: 100 })),
  )
  assert(!tooManySteps.success, '> 100 steps is rejected')

  // ============ Test 2: Step permissions per run mode ============
  console.log('\n2. Step permissions per run mode')

  assert(isStepAllowedForMode('NAVIGATE', 'PASSIVE'), 'NAVIGATE allowed in PASSIVE')
  assert(!isStepAllowedForMode('CLICK', 'PASSIVE'), 'CLICK NOT allowed in PASSIVE')
  assert(isStepAllowedForMode('CLICK', 'SAFE_INTERACTION'), 'CLICK allowed in SAFE_INTERACTION')
  assert(!isStepAllowedForMode('UPLOAD_TEST_FILE', 'SAFE_INTERACTION'), 'UPLOAD_TEST_FILE NOT allowed in SAFE_INTERACTION')
  assert(isStepAllowedForMode('UPLOAD_TEST_FILE', 'TEST_TRANSACTION'), 'UPLOAD_TEST_FILE allowed in TEST_TRANSACTION')
  assert(!isStepAllowedForMode('CUSTOM_SAFE_SCRIPT', 'TEST_TRANSACTION'), 'CUSTOM_SAFE_SCRIPT NOT allowed in TEST_TRANSACTION')
  assert(isStepAllowedForMode('CUSTOM_SAFE_SCRIPT', 'CUSTOM_APPROVED'), 'CUSTOM_SAFE_SCRIPT allowed in CUSTOM_APPROVED')

  // Minimum mode for step
  assert(minimumModeForStep('NAVIGATE') === 'PASSIVE', 'NAVIGATE min mode = PASSIVE')
  assert(minimumModeForStep('CLICK') === 'SAFE_INTERACTION', 'CLICK min mode = SAFE_INTERACTION')
  assert(minimumModeForStep('UPLOAD_TEST_FILE') === 'TEST_TRANSACTION', 'UPLOAD_TEST_FILE min mode = TEST_TRANSACTION')
  assert(minimumModeForStep('CUSTOM_SAFE_SCRIPT') === 'CUSTOM_APPROVED', 'CUSTOM_SAFE_SCRIPT min mode = CUSTOM_APPROVED')

  // ============ Test 3: Safe action policy ============
  console.log('\n3. Safe action policy (destructive action blocklist)')

  // Destructive URL detection
  assert(isDestructiveUrl('https://example.com/logout'), 'logout URL detected as destructive')
  assert(isDestructiveUrl('https://example.com/delete-account'), 'delete-account URL detected')
  assert(isDestructiveUrl('https://example.com/supprimer'), 'French "supprimer" URL detected')
  assert(isDestructiveUrl('https://example.com/abmelden'), 'German "abmelden" URL detected')
  assert(!isDestructiveUrl('https://example.com/dashboard'), 'dashboard URL not destructive')

  // Destructive selector detection
  assert(isDestructiveSelector('[href="/logout"]'), 'logout href selector detected')
  assert(isDestructiveSelector('#delete-account'), 'delete-account id selector detected')
  assert(isDestructiveSelector('.unsubscribe-btn'), 'unsubscribe class selector detected')
  assert(!isDestructiveSelector('#submit-button'), 'submit-button selector not destructive')

  // Destructive text detection
  assert(isDestructiveText('Delete account'), 'Delete account text detected')
  assert(isDestructiveText('Se deconnecter'), 'French "Se deconnecter" text detected')
  assert(!isDestructiveText('Save changes'), 'Save changes text not destructive')

  // validateStepsAgainstPolicy
  const destructiveSteps: JourneyStep[] = [
    { type: 'NAVIGATE', url: 'https://example.com/logout' },
    { type: 'CLICK', selector: '[href="/delete"]' },
  ]
  const policyResult = validateStepsAgainstPolicy(destructiveSteps, 'SAFE_INTERACTION')
  assert(!policyResult.ok, 'Destructive steps fail policy validation')
  assert(policyResult.violations.length === 2, '2 violations reported')

  // Step not allowed for mode
  const passiveSteps: JourneyStep[] = [
    { type: 'CLICK', selector: '#submit' },
  ]
  const passiveResult = validateStepsAgainstPolicy(passiveSteps, 'PASSIVE')
  assert(!passiveResult.ok, 'CLICK in PASSIVE mode fails policy')
  assert(passiveResult.violations[0]?.code === 'step_not_allowed_for_mode', 'violation code = step_not_allowed_for_mode')

  // Valid steps pass
  const safeSteps: JourneyStep[] = [
    { type: 'NAVIGATE', url: 'https://example.com/' },
    { type: 'CLICK', selector: '#submit' },
    { type: 'ASSERT_VISIBLE', selector: '.success' },
  ]
  const safeResult = validateStepsAgainstPolicy(safeSteps, 'SAFE_INTERACTION')
  assert(safeResult.ok, 'Safe steps pass policy validation in SAFE_INTERACTION mode')

  // ============ Test 4: Project secrets vault ============
  console.log('\n4. Project secrets vault')

  // Set a secret
  const secret = await setSecret(
    project.id,
    'TEST_PASSWORD',
    'super-secret-value-123',
    'Test password for Phase 7 verification',
    owner.userId,
    owner.role as 'OWNER',
    ctx,
  )
  assert(secret.key === 'TEST_PASSWORD', 'Secret created with correct key')
  assert(!('valueEncrypted' in secret), 'Secret metadata does NOT include encrypted value')
  assert(!('value' in secret), 'Secret metadata does NOT include plaintext value')

  // List secrets — should only return keys, never values
  const secrets = await listSecrets(project.id, owner.userId, owner.role as 'OWNER')
  const found = secrets.find((s) => s.key === 'TEST_PASSWORD')
  assert(!!found, 'TEST_PASSWORD appears in secret list')
  assert(!JSON.stringify(found).includes('super-secret-value-123'), 'Plaintext value NOT in list response')

  // Resolve secret (worker-only function)
  const resolved = await resolveSecret(project.id, 'TEST_PASSWORD')
  assert(resolved === 'super-secret-value-123', 'resolveSecret returns plaintext value')

  // Resolve missing secret returns null
  const missing = await resolveSecret(project.id, 'NONEXISTENT_KEY')
  assert(missing === null, 'resolveSecret returns null for missing key')

  // extractSecretKeys
  const stepsWithSecrets: JourneyStep[] = [
    { type: 'TYPE', selector: 'input[name=pwd]', secretRef: '{{secret.PASSWORD}}' },
    { type: 'TYPE', selector: 'input[name=token]', secretRef: '{{secret.API_TOKEN}}' },
    { type: 'CLICK', selector: '#submit' },
  ]
  const keys = extractSecretKeys(stepsWithSecrets)
  assert(keys.length === 2, 'extractSecretKeys finds 2 unique keys')
  assert(keys.includes('PASSWORD'), 'extractSecretKeys finds PASSWORD')
  assert(keys.includes('API_TOKEN'), 'extractSecretKeys finds API_TOKEN')

  // resolveSecretsForSteps (batched)
  await setSecret(project.id, 'PASSWORD', 'pwd-456', null, owner.userId, owner.role as 'OWNER', ctx)
  await setSecret(project.id, 'API_TOKEN', 'tok-789', null, owner.userId, owner.role as 'OWNER', ctx)
  const secretMap = await resolveSecretsForSteps(project.id, keys)
  assert(secretMap.get('PASSWORD') === 'pwd-456', 'Batch resolve returns PASSWORD value')
  assert(secretMap.get('API_TOKEN') === 'tok-789', 'Batch resolve returns API_TOKEN value')

  // Set another secret with same key (upsert)
  await setSecret(project.id, 'TEST_PASSWORD', 'updated-value', null, owner.userId, owner.role as 'OWNER', ctx)
  const updated = await resolveSecret(project.id, 'TEST_PASSWORD')
  assert(updated === 'updated-value', 'setSecret upserts (updates existing key)')

  // ============ Test 5: Journey CRUD ============
  console.log('\n5. Journey CRUD + versioning')

  // Create a journey
  const journey = await createJourney(
    {
      projectId: project.id,
      name: 'Test Login Journey',
      description: 'Verify user can log in',
      steps: [
        { type: 'NAVIGATE', url: '/login' },
        { type: 'TYPE', selector: 'input[name=email]', text: 'test@example.com' },
        { type: 'TYPE', selector: 'input[name=password]', secretRef: '{{secret.PASSWORD}}' },
        { type: 'CLICK', selector: 'button[type=submit]' },
        { type: 'ASSERT_VISIBLE', selector: '.dashboard' },
      ],
    },
    owner.userId,
    owner.role as 'OWNER',
    ctx,
  )
  assert(journey.id.length > 0, 'Journey created with ID')
  assert(journey.currentVersion === 1, 'Journey starts at version 1')
  assert(journey.status === 'DRAFT', 'Journey starts in DRAFT status')
  assert(journey.steps.length === 5, 'Journey has 5 steps')
  assert(journey.secretKeys.length === 1 && journey.secretKeys[0] === 'PASSWORD', 'Journey exposes secretKeys for UI hinting')

  // Get the journey
  const fetched = await getJourney(journey.id, owner.userId)
  assert(fetched.id === journey.id, 'getJourney returns same journey')
  assert(fetched.steps.length === 5, 'getJourney returns all 5 steps')
  assert(fetched.steps[1]?.type === 'TYPE', 'Step 2 is TYPE')
  assert((fetched.steps[1] as { text?: string }).text === 'test@example.com', 'Step 2 text preserved')

  // Update journey — bump version with new steps
  const updated2 = await updateJourney(
    journey.id,
    {
      steps: [
        { type: 'NAVIGATE', url: '/login' },
        { type: 'TYPE', selector: 'input[name=email]', text: 'test@example.com' },
        { type: 'TYPE', selector: 'input[name=password]', secretRef: '{{secret.PASSWORD}}' },
        { type: 'CLICK', selector: 'button[type=submit]' },
        { type: 'ASSERT_VISIBLE', selector: '.dashboard' },
        { type: 'SCREENSHOT', label: 'final' }, // new step
      ],
      changeLog: 'Added screenshot at end',
    },
    owner.userId,
    owner.role as 'OWNER',
    ctx,
  )
  assert(updated2.currentVersion === 2, 'Journey version bumped to 2 after step change')
  assert(updated2.steps.length === 6, 'New version has 6 steps')

  // Update journey — name only (no version bump)
  const renamed = await updateJourney(
    journey.id,
    { name: 'Renamed Journey' },
    owner.userId,
    owner.role as 'OWNER',
    ctx,
  )
  assert(renamed.name === 'Renamed Journey', 'Journey renamed')
  assert(renamed.currentVersion === 2, 'Name change does NOT bump version')
  assert(renamed.steps.length === 6, 'Steps unchanged after rename')

  // List versions
  const versions = await listJourneyVersions(journey.id, owner.userId)
  assert(versions.length === 2, '2 versions exist')
  assert(versions[0]?.version === 2, 'Newest version is 2')
  assert(versions[1]?.version === 1, 'Oldest version is 1')

  // Get specific version
  const v1 = await getJourneyVersion(journey.id, 1, owner.userId)
  assert(v1.version === 1, 'getJourneyVersion returns version 1')
  assert(v1.steps.length === 5, 'Version 1 has 5 steps (original)')

  // Rollback to version 1
  const rolled = await rollbackJourney(journey.id, 1, owner.userId, owner.role as 'OWNER', ctx)
  assert(rolled.currentVersion === 1, 'Journey rolled back to version 1')
  assert(rolled.steps.length === 5, 'Steps now reflect version 1')

  // Versions list still has both (no deletion)
  const versionsAfterRollback = await listJourneyVersions(journey.id, owner.userId)
  assert(versionsAfterRollback.length === 2, 'Both versions still exist after rollback')

  // Activate the journey
  const activated = await updateJourney(
    journey.id,
    { status: 'ACTIVE' },
    owner.userId,
    owner.role as 'OWNER',
    ctx,
  )
  assert(activated.status === 'ACTIVE', 'Journey activated')

  // List journeys
  const list = await listJourneys(project.id, owner.userId, { limit: 10 })
  const foundInList = list.items.find((j) => j.id === journey.id)
  assert(!!foundInList, 'Journey appears in list')
  assert(foundInList?.status === 'ACTIVE', 'Listed journey is ACTIVE')

  // ============ Test 6: Journey validation (dry-run) ============
  console.log('\n6. Journey validation (dry-run)')

  const validation = await validateJourney(
    project.id,
    [
      { type: 'NAVIGATE', url: '/login' },
      { type: 'TYPE', selector: 'input[name=password]', secretRef: '{{secret.PASSWORD}}' },
      { type: 'TYPE', selector: 'input[name=missing]', secretRef: '{{secret.NONEXISTENT}}' },
    ],
    'SAFE_INTERACTION',
    owner.userId,
  )
  assert(validation.stepsValid, 'Steps parse OK')
  assert(validation.policy.ok, 'Policy OK (no destructive patterns)')
  assert(validation.secretKeys.length === 2, '2 secret keys referenced')
  assert(validation.missingSecretKeys.length === 1, '1 missing secret detected')
  assert(validation.missingSecretKeys[0] === 'NONEXISTENT', 'NONEXISTENT flagged as missing')
  assert(!validation.ok, 'Validation fails overall (missing secret)')
  assert(validation.suggestedRunMode === 'SAFE_INTERACTION', 'Suggested mode = SAFE_INTERACTION (because of TYPE step)')

  // Validation with destructive patterns
  const badValidation = await validateJourney(
    project.id,
    [{ type: 'NAVIGATE', url: 'https://example.com/logout' }],
    'PASSIVE',
    owner.userId,
  )
  assert(badValidation.policy.ok === false, 'Policy fails for destructive URL')
  assert(badValidation.policy.violations[0]?.code === 'destructive_url', 'violation code = destructive_url')

  // ============ Test 7: serializeSteps / parseSteps roundtrip ============
  console.log('\n7. serializeSteps / parseSteps roundtrip')

  const json = serializeSteps(validSteps)
  const reparsed = parseSteps(json)
  assert(reparsed.length === validSteps.length, 'Roundtrip preserves step count')
  assert(reparsed[0]?.type === 'NAVIGATE', 'Roundtrip preserves step types')

  // ============ Test 8: Cleanup ============
  console.log('\n8. Cleanup')

  await deleteJourney(journey.id, owner.userId, owner.role as 'OWNER', ctx)
  const deleted = await db.journey.findUnique({ where: { id: journey.id } })
  assert(deleted?.status === 'DELETED', 'Journey soft-deleted (status=DELETED)')

  // Delete test secrets
  await db.projectSecret.deleteMany({ where: { projectId: project.id } })
  const remainingSecrets = await listSecrets(project.id, owner.userId, owner.role as 'OWNER')
  assert(remainingSecrets.length === 0, 'All test secrets deleted')

  // ============ Summary ============
  console.log('\n========================================')
  console.log(`Phase 7 verification: ${testsPassed} passed, ${testsFailed} failed`)
  console.log('========================================')
  if (testsFailed > 0) {
    process.exit(1)
  }
}

main()
  .catch((err) => {
    console.error('Standalone test crashed:', err)
    process.exit(1)
  })
  .finally(async () => {
    await db.$disconnect()
  })
