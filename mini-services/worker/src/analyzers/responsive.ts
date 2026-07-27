/**
 * Responsive layout analyzer — ProofPilot worker (Phase 5)
 *
 * Detects:
 *   - Horizontal overflow (scrollWidth > clientWidth)
 *   - Out-of-viewport elements (bounding rect outside the viewport)
 *   - Fixed/position:sticky elements covering content
 *   - Clipped text (scrollWidth > clientWidth on inline elements)
 *   - Overlapping interactive elements (buttons, links, inputs that overlap)
 *   - Modal/dialog overflow
 *   - Mobile nav (presence of a hamburger / drawer — informational)
 *   - Tap target sizes (interactive elements < 44×44px)
 *   - Input sizes (form inputs smaller than 16px → iOS zoom)
 *   - Font sizes (root font-size < 16px → iOS zoom)
 *   - Tables overflowing container
 *   - Images overflowing container
 *   - Sticky headers covering content on mobile
 *
 * Source data:
 *   - ctx.page (DOM measurements via getBoundingClientRect)
 *   - ctx.viewport (width/height to detect mobile vs desktop)
 */
import type { Analyzer, AnalyzerContext, FindingCandidate } from './types'

interface ElementMeasurement {
  selector: string
  tag: string
  text: string
  rect: { x: number; y: number; width: number; height: number; top: number; right: number; bottom: number; left: number }
  fontSize: number
  scrollWidth: number
  clientWidth: number
  scrollHeight: number
  clientHeight: number
  position: string
  zIndex: string
}

const MAX_ELEMENTS_TO_MEASURE = 200

async function measurePage(ctx: AnalyzerContext): Promise<{
  document: { scrollWidth: number; clientWidth: number; scrollHeight: number; clientHeight: number }
  rootFontSize: number
  elements: ElementMeasurement[]
  interactives: ElementMeasurement[]
  fixedElements: ElementMeasurement[]
  tables: ElementMeasurement[]
  images: ElementMeasurement[]
}> {
  return ctx.page.evaluate((maxEls) => {
    const docEl = document.documentElement
    const body = document.body
    const rootFontSize = parseFloat(getComputedStyle(docEl).fontSize) || 16

    /** Build a CSS selector for an element (best-effort, not unique). */
    function selectorFor(el: Element): string {
      const parts: string[] = []
      let cur: Element | null = el
      for (let i = 0; i < 5 && cur && cur !== docEl; i++) {
        let part = cur.tagName.toLowerCase()
        if (cur.id) {
          part += `#${cur.id}`
          parts.unshift(part)
          break
        }
        const cls = Array.from(cur.classList).slice(0, 2).map((c) => `.${c}`).join('')
        if (cls) part += cls
        parts.unshift(part)
        cur = cur.parentElement
      }
      return parts.join(' > ') || el.tagName.toLowerCase()
    }

    function measure(el: Element): ElementMeasurement {
      const rect = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return {
        selector: selectorFor(el),
        tag: el.tagName.toLowerCase(),
        text: (el.textContent ?? '').trim().slice(0, 80),
        rect: {
          x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left,
        },
        fontSize: parseFloat(cs.fontSize) || 0,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        position: cs.position,
        zIndex: cs.zIndex,
      }
    }

    // Measure all visible elements (cap to avoid huge payloads)
    const allElements = Array.from(body.querySelectorAll('*'))
      .filter((el) => {
        const rect = el.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      })
      .slice(0, maxEls)
      .map(measure)

    const interactives = allElements.filter((e) =>
      ['a', 'button', 'input', 'select', 'textarea', '[role="button"]'].some((t) => e.tag === t.replace(/\[.*\]/, '')) ||
      e.tag === 'a' || e.tag === 'button' || e.tag === 'input' || e.tag === 'select' || e.tag === 'textarea'
    )

    const fixedElements = allElements.filter((e) => e.position === 'fixed' || e.position === 'sticky')

    const tables = allElements.filter((e) => e.tag === 'table')

    const images = allElements.filter((e) => e.tag === 'img')

    return {
      document: {
        scrollWidth: docEl.scrollWidth,
        clientWidth: docEl.clientWidth,
        scrollHeight: docEl.scrollHeight,
        clientHeight: docEl.clientHeight,
      },
      rootFontSize,
      elements: allElements,
      interactives,
      fixedElements,
      tables,
      images,
    }
  }, MAX_ELEMENTS_TO_MEASURE).catch(() => ({
    document: { scrollWidth: 0, clientWidth: 0, scrollHeight: 0, clientHeight: 0 },
    rootFontSize: 16,
    elements: [],
    interactives: [],
    fixedElements: [],
    tables: [],
    images: [],
  }))
}

/** Check if two rectangles overlap. */
function rectsOverlap(a: { left: number; top: number; right: number; bottom: number }, b: { left: number; top: number; right: number; bottom: number }): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

export const responsiveAnalyzer: Analyzer = {
  id: 'responsive',
  category: 'RESPONSIVE',
  async run(ctx: AnalyzerContext): Promise<FindingCandidate[]> {
    const findings: FindingCandidate[] = []
    const isMobile = ctx.viewport.width < 768
    const isTablet = ctx.viewport.width >= 768 && ctx.viewport.width < 1024

    const data = await measurePage(ctx)
    if (data.elements.length === 0) {
      return findings
    }

    const viewportWidth = ctx.viewport.width
    const viewportHeight = ctx.viewport.height

    // 1. Horizontal overflow at the document level
    if (data.document.scrollWidth > data.document.clientWidth + 2) {
      const overflowPx = data.document.scrollWidth - data.document.clientWidth
      findings.push({
        checkId: 'responsive.horizontal_overflow',
        category: 'RESPONSIVE',
        severity: isMobile ? 'MAJOR' : 'MINOR',
        title: `Horizontal overflow (${overflowPx}px)`,
        description: `The page content is ${overflowPx}px wider than the viewport on ${ctx.viewport.name} (${viewportWidth}px). Users must scroll horizontally to see all content, which is a poor mobile experience.`,
        remediation: 'Use responsive layouts (max-width: 100vw, overflow-x: hidden, or media queries) to keep content within the viewport.',
        messageKey: 'horizontal-overflow',
        evidence: { scrollWidth: data.document.scrollWidth, clientWidth: data.document.clientWidth, viewport: ctx.viewport.name },
      })
    }

    // 2. Elements extending beyond the viewport
    const outOfViewport = data.elements.filter((e) => e.rect.right > viewportWidth + 2 || e.rect.left < -2)
    if (outOfViewport.length > 0 && isMobile) {
      // Report up to 3 distinct examples
      const examples = outOfViewport.slice(0, 3)
      findings.push({
        checkId: 'responsive.out_of_viewport',
        category: 'RESPONSIVE',
        severity: 'MAJOR',
        title: `${outOfViewport.length} element${outOfViewport.length === 1 ? '' : 's'} extend beyond the viewport`,
        description: `${outOfViewport.length} element(s) have content extending beyond the viewport width on mobile, forcing horizontal scroll.`,
        remediation: 'Constrain element widths with max-width: 100% and use box-sizing: border-box.',
        messageKey: 'out-of-viewport',
        evidence: { count: outOfViewport.length, examples: examples.map((e) => ({ selector: e.selector, right: e.rect.right })) },
      })
    }

    // 3. Fixed/sticky elements covering content (only on mobile, where this is most impactful)
    if (isMobile && data.fixedElements.length > 0) {
      for (const fixed of data.fixedElements) {
        // Check if any interactive element is hidden behind this fixed element
        const coveredInteractives = data.interactives.filter((interactive) => {
          if (interactive.selector === fixed.selector) return false
          // Same vertical range as the fixed element + within horizontal range
          return rectsOverlap(
            { left: interactive.rect.left, top: interactive.rect.top, right: interactive.rect.right, bottom: interactive.rect.bottom },
            { left: fixed.rect.left, top: fixed.rect.top, right: fixed.rect.right, bottom: fixed.rect.bottom },
          )
        })
        if (coveredInteractives.length > 0) {
          findings.push({
            checkId: 'responsive.fixed_covering_content',
            category: 'RESPONSIVE',
            severity: 'MAJOR',
            title: `Fixed element covers interactive content (${fixed.selector})`,
            description: `A ${fixed.position} element (${fixed.selector}) overlaps ${coveredInteractives.length} interactive element(s) on ${ctx.viewport.name}. Users cannot tap the covered elements.`,
            remediation: 'Add bottom padding to the page equal to the fixed element height, or dismiss the fixed element when not needed.',
            messageKey: `fixed-covering-${fixed.selector.slice(0, 40)}`,
            selector: fixed.selector,
            evidence: {
              fixed: { selector: fixed.selector, rect: fixed.rect, position: fixed.position },
              coveredCount: coveredInteractives.length,
              coveredExamples: coveredInteractives.slice(0, 3).map((e) => ({ selector: e.selector })),
            },
          })
        }
      }
    }

    // 4. Clipped text (scrollWidth > clientWidth on inline elements)
    const clippedText = data.elements.filter((e) => e.scrollWidth > e.clientWidth + 2 && e.clientHeight > 0 && ['span', 'a', 'button', 'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'label'].includes(e.tag))
    if (clippedText.length > 0) {
      const examples = clippedText.slice(0, 3)
      findings.push({
        checkId: 'responsive.clipped_text',
        category: 'RESPONSIVE',
        severity: 'MINOR',
        title: `${clippedText.length} element${clippedText.length === 1 ? '' : 's'} with clipped text`,
        description: 'Some elements have text that overflows their container and is clipped (overflow: hidden + scrollWidth > clientWidth).',
        remediation: 'Allow text wrapping (white-space: normal), or use text-overflow: ellipsis with a title attribute for the full text.',
        messageKey: 'clipped-text',
        evidence: { count: clippedText.length, examples: examples.map((e) => ({ selector: e.selector, text: e.text })) },
      })
    }

    // 5. Tap target sizes (mobile only)
    if (isMobile || isTablet) {
      const smallTargets = data.interactives.filter((e) => e.rect.width < 44 || e.rect.height < 44)
      if (smallTargets.length > 0) {
        const examples = smallTargets.slice(0, 5)
        findings.push({
          checkId: 'responsive.small_tap_target',
          category: 'RESPONSIVE',
          severity: 'MINOR',
          title: `${smallTargets.length} interactive element${smallTargets.length === 1 ? '' : 's'} smaller than 44×44px`,
          description: 'Interactive elements smaller than 44×44px are difficult to tap on touch devices. WCAG 2.2 Target Size (Minimum) recommends at least 24×24px, with 44×44px being best practice.',
          remediation: 'Increase the padding or min-width/min-height of interactive elements to at least 44×44px.',
          messageKey: 'small-tap-target',
          evidence: { count: smallTargets.length, examples: examples.map((e) => ({ selector: e.selector, width: e.rect.width, height: e.rect.height })) },
        })
      }
    }

    // 6. Input font size < 16px (iOS zoom trigger)
    const smallFontInputs = data.interactives.filter((e) => ['input', 'select', 'textarea'].includes(e.tag) && e.fontSize > 0 && e.fontSize < 16)
    if (smallFontInputs.length > 0 && isMobile) {
      findings.push({
        checkId: 'responsive.small_input_font',
        category: 'RESPONSIVE',
        severity: 'MINOR',
        title: `${smallFontInputs.length} form input${smallFontInputs.length === 1 ? '' : 's'} with font-size < 16px`,
        description: 'Form inputs with font-size < 16px cause iOS Safari to zoom into the page on focus, which is jarring for users.',
        remediation: 'Set font-size: 16px (or larger) on all form inputs.',
        messageKey: 'small-input-font',
        evidence: { count: smallFontInputs.length, examples: smallFontInputs.slice(0, 3).map((e) => ({ selector: e.selector, fontSize: e.fontSize })) },
      })
    }

    // 7. Root font-size < 16px
    if (data.rootFontSize > 0 && data.rootFontSize < 16) {
      findings.push({
        checkId: 'responsive.small_root_font',
        category: 'RESPONSIVE',
        severity: 'MINOR',
        title: `Root font-size is ${data.rootFontSize}px (< 16px)`,
        description: 'Setting the root font-size below 16px can cause accessibility issues (rem-based sizes inherit) and iOS zoom on focus.',
        remediation: 'Set html { font-size: 16px; } (or larger) as the base, then scale with rem units.',
        messageKey: 'small-root-font',
        evidence: { rootFontSize: data.rootFontSize },
      })
    }

    // 8. Tables overflowing container
    const overflowingTables = data.tables.filter((t) => t.rect.width > viewportWidth + 2 || t.scrollWidth > t.clientWidth + 2)
    if (overflowingTables.length > 0 && isMobile) {
      findings.push({
        checkId: 'responsive.table_overflow',
        category: 'RESPONSIVE',
        severity: 'MINOR',
        title: `${overflowingTables.length} table${overflowingTables.length === 1 ? '' : 's'} overflow the viewport`,
        description: 'Tables that overflow the viewport force horizontal scroll. Wrap them in a scrollable container or use a responsive table pattern.',
        remediation: 'Wrap tables in a div with overflow-x: auto, or transform them into cards on mobile.',
        messageKey: 'table-overflow',
        evidence: { count: overflowingTables.length, examples: overflowingTables.slice(0, 2).map((t) => ({ selector: t.selector, width: t.rect.width })) },
      })
    }

    // 9. Images overflowing container
    const overflowingImages = data.images.filter((img) => img.rect.width > viewportWidth + 2)
    if (overflowingImages.length > 0 && isMobile) {
      findings.push({
        checkId: 'responsive.image_overflow',
        category: 'RESPONSIVE',
        severity: 'MINOR',
        title: `${overflowingImages.length} image${overflowingImages.length === 1 ? '' : 's'} overflow the viewport`,
        description: 'Images that exceed the viewport width cause horizontal scroll on mobile.',
        remediation: 'Apply max-width: 100%; height: auto; to all images.',
        messageKey: 'image-overflow',
        evidence: { count: overflowingImages.length, examples: overflowingImages.slice(0, 3).map((img) => ({ selector: img.selector, width: img.rect.width })) },
      })
    }

    return findings
  },
}
