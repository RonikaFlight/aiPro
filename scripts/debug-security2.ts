import { db } from '../src/lib/db'
import { launchBrowser, createContext, navigateSafely, closeContext } from '../mini-services/worker/src/browser'
import { env } from '../src/lib/env'

const TEST_HTML = `<!DOCTYPE html><html><head><title>Test</title></head><body><h1>Hello</h1></body></html>`

const server = Bun.serve({
  port: 4569,
  fetch() {
    return new Response(TEST_HTML, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  },
})

async function main() {
  const targetUrl = 'http://localhost:4569/'
  const allowedOrigins = ['http://localhost:4569']

  const browser = await launchBrowser({ allowNoSandbox: env.APP_ENV === 'development' })
  const context = await createContext(browser, {
    allowedOrigins,
    viewport: { width: 1366, height: 768 },
    locale: 'en',
  })

  const responses: any[] = []
  const page = await context.newPage()

  page.on('response', (response) => {
    try {
      const url = response.url()
      const status = response.status()
      const headers = response.headers()
      console.log(`[response] url=${url} status=${status} headers=${JSON.stringify(headers)}`)
      responses.push({ url, status, headers, contentType: headers['content-type'] ?? '' })
    } catch (e) {
      console.error('[response error]', e)
    }
  })

  console.log('Navigating to', targetUrl)
  const navResult = await navigateSafely(page, targetUrl, allowedOrigins, { waitUntil: 'load' })
  console.log('Navigation result:', navResult.finalUrl)

  await page.waitForTimeout(1500)

  console.log(`\nTotal responses captured: ${responses.length}`)
  for (const r of responses) {
    console.log(`  ${r.url} — status=${r.status} contentType=${r.contentType} headers=${Object.keys(r.headers).join(',')}`)
  }

  // Check if any response matches the page URL
  const doc = responses.find((r) => r.url === targetUrl)
  console.log(`\nDocument response found: ${doc ? 'YES' : 'NO'}`)
  if (doc) {
    console.log('Headers:', JSON.stringify(doc.headers, null, 2))
    const hasCsp = Object.keys(doc.headers).some((h) => h.toLowerCase() === 'content-security-policy')
    console.log(`Has CSP: ${hasCsp}`)
  }

  await closeContext(context)
  await browser.close()
  server.stop()
  await db.$disconnect()
}
main().catch(console.error)
