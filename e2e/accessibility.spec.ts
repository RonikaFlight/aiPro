import { test, expect } from '@playwright/test'

test.describe('Accessibility — Landing Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('document has lang attribute', async ({ page }) => {
    const lang = await page.getAttribute('html', 'lang')
    expect(lang).toBeTruthy()
    expect(['en', 'fa']).toContain(lang)
  })

  test('document has dir attribute matching lang', async ({ page }) => {
    const lang = await page.getAttribute('html', 'lang')
    const dir = await page.getAttribute('html', 'dir')
    if (lang === 'fa') {
      expect(dir).toBe('rtl')
    } else {
      // en can be ltr or unset (default)
      expect(dir === 'ltr' || dir === null).toBeTruthy()
    }
  })

  test('has main landmark', async ({ page }) => {
    const main = page.locator('main')
    await expect(main).toBeVisible()
  })

  test('has exactly one h1', async ({ page }) => {
    const headings = page.locator('h1')
    const count = await headings.count()
    expect(count).toBe(1)
  })

  test('all images have alt text', async ({ page }) => {
    const images = page.locator('img')
    const count = await images.count()
    for (let i = 0; i < count; i++) {
      const img = images.nth(i)
      const alt = await img.getAttribute('alt')
      expect(alt).not.toBeNull()
    }
  })

  test('all links have href', async ({ page }) => {
    const links = page.locator('a')
    const count = await links.count()
    for (let i = 0; i < count; i++) {
      const link = links.nth(i)
      const href = await link.getAttribute('href')
      expect(href).toBeTruthy()
      expect(href?.length).toBeGreaterThan(0)
    }
  })

  test('headings are in logical order', async ({ page }) => {
    const headings = page.locator('h1, h2, h3, h4, h5, h6')
    const count = await headings.count()
    let prevLevel = 0
    for (let i = 0; i < count; i++) {
      const heading = headings.nth(i)
      const tag = await heading.evaluate(el => el.tagName)
      const level = parseInt(tag.charAt(1))
      // Headings should not skip more than one level (e.g., h1 → h3)
      // but we allow equal or lower levels
      expect(level).toBeLessThanOrEqual(prevLevel + 1)
      if (level > prevLevel) prevLevel = level
    }
  })

  test('page title is not empty', async ({ page }) => {
    const title = await page.title()
    expect(title).toBeTruthy()
    expect(title.length).toBeGreaterThan(2)
  })
})

test.describe('Accessibility — Login Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login')
  })

  test('form inputs have labels or aria-label', async ({ page }) => {
    const inputs = page.locator('input:not([type="hidden"])')
    const count = await inputs.count()
    for (let i = 0; i < count; i++) {
      const input = inputs.nth(i)
      // Check for label via for/id association, wrapping label, aria-label, or aria-labelledby
      const id = await input.getAttribute('id')
      const ariaLabel = await input.getAttribute('aria-label')
      const ariaLabelledBy = await input.getAttribute('aria-labelledby')
      const placeholder = await input.getAttribute('placeholder')

      let hasLabel = false
      if (ariaLabel) hasLabel = true
      if (ariaLabelledBy) hasLabel = true
      if (placeholder) hasLabel = true
      if (id) {
        const label = page.locator(`label[for="${id}"]`)
        hasLabel = hasLabel || (await label.count()) > 0
      }

      // At least one form of labeling should exist
      expect(hasLabel).toBeTruthy()
    }
  })

  test('submit button has accessible name', async ({ page }) => {
    const buttons = page.locator('button[type="submit"]')
    const count = await buttons.count()
    for (let i = 0; i < count; i++) {
      const btn = buttons.nth(i)
      const text = await btn.textContent()
      const ariaLabel = await btn.getAttribute('aria-label')
      const hasName = (text && text.trim().length > 0) || ariaLabel
      expect(hasName).toBeTruthy()
    }
  })
})

test.describe('Accessibility — Registration Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/register')
  })

  test('form inputs have labels or aria-label', async ({ page }) => {
    const inputs = page.locator('input:not([type="hidden"])')
    const count = await inputs.count()
    for (let i = 0; i < count; i++) {
      const input = inputs.nth(i)
      const id = await input.getAttribute('id')
      const ariaLabel = await input.getAttribute('aria-label')
      const ariaLabelledBy = await input.getAttribute('aria-labelledby')
      const placeholder = await input.getAttribute('placeholder')

      let hasLabel = false
      if (ariaLabel) hasLabel = true
      if (ariaLabelledBy) hasLabel = true
      if (placeholder) hasLabel = true
      if (id) {
        const label = page.locator(`label[for="${id}"]`)
        hasLabel = hasLabel || (await label.count()) > 0
      }

      expect(hasLabel).toBeTruthy()
    }
  })
})
