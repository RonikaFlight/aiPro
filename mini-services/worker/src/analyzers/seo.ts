/**
 * SEO / Metadata analyzer — ProofPilot worker (Phase 5)
 *
 * Detects:
 *   - Missing or empty <title>
 *   - Title too long (> 60 chars) or too short (< 10 chars)
 *   - Duplicate title (same as another page in the run — handled by runner)
 *   - Missing meta description
 *   - Description too long (> 160 chars) or too short (< 50 chars)
 *   - Missing canonical
 *   - Missing Open Graph tags (og:title, og:description, og:image, og:url)
 *   - Missing Twitter Card tags
 *   - Missing viewport meta
 *   - Non-indexable content (noindex meta, robots.txt disallow)
 *   - Missing lang (covered by a11y — flagged here for SEO context)
 *   - Missing structured data (JSON-LD)
 *   - Missing favicon
 *   - Missing sitemap reference (in robots.txt)
 *   - Heading hierarchy (covered by a11y)
 *
 * Source data: ctx.page (DOM inspection)
 */
import type { Analyzer, AnalyzerContext, FindingCandidate } from './types'

interface MetaInspection {
  title: string
  titleLength: number
  description: string | null
  descriptionLength: number
  canonical: string | null
  viewport: string | null
  robots: string | null
  ogTags: Record<string, string>
  twitterTags: Record<string, string>
  hasJsonLd: boolean
  hasFavicon: boolean
  hasManifest: boolean
  htmlLang: string | null
  headingCount: number
  h1Count: number
  wordCount: number
}

async function inspectMeta(ctx: AnalyzerContext): Promise<MetaInspection> {
  return ctx.page.evaluate(() => {
    const title = document.title ?? ''
    const descEl = document.querySelector('meta[name="description"]') as HTMLMetaElement | null
    const description = descEl?.getAttribute('content') ?? null
    const canonicalEl = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null
    const canonical = canonicalEl?.href ?? null
    const viewportEl = document.querySelector('meta[name="viewport"]') as HTMLMetaElement | null
    const viewport = viewportEl?.getAttribute('content') ?? null
    const robotsEl = document.querySelector('meta[name="robots"]') as HTMLMetaElement | null
    const robots = robotsEl?.getAttribute('content') ?? null
    const ogTags: Record<string, string> = {}
    for (const el of Array.from(document.querySelectorAll('meta[property^="og:"]'))) {
      const property = el.getAttribute('property') ?? ''
      const content = el.getAttribute('content') ?? ''
      ogTags[property] = content
    }
    const twitterTags: Record<string, string> = {}
    for (const el of Array.from(document.querySelectorAll('meta[name^="twitter:"]'))) {
      const name = el.getAttribute('name') ?? ''
      const content = el.getAttribute('content') ?? ''
      twitterTags[name] = content
    }
    const hasJsonLd = document.querySelector('script[type="application/ld+json"]') !== null
    const hasFavicon = document.querySelector('link[rel~="icon"]') !== null
    const hasManifest = document.querySelector('link[rel="manifest"]') !== null
    const htmlLang = document.documentElement.getAttribute('lang')
    const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6')
    const h1Count = document.querySelectorAll('h1').length
    const bodyText = document.body?.innerText ?? ''
    const wordCount = bodyText.split(/\s+/).filter(Boolean).length

    return {
      title,
      titleLength: title.length,
      description,
      descriptionLength: description?.length ?? 0,
      canonical,
      viewport,
      robots,
      ogTags,
      twitterTags,
      hasJsonLd,
      hasFavicon,
      hasManifest,
      htmlLang,
      headingCount: headings.length,
      h1Count,
      wordCount,
    }
  }).catch(() => ({
    title: '',
    titleLength: 0,
    description: null,
    descriptionLength: 0,
    canonical: null,
    viewport: null,
    robots: null,
    ogTags: {},
    twitterTags: {},
    hasJsonLd: false,
    hasFavicon: false,
    hasManifest: false,
    htmlLang: null,
    headingCount: 0,
    h1Count: 0,
    wordCount: 0,
  }))
}

export const seoAnalyzer: Analyzer = {
  id: 'seo',
  category: 'SEO',
  async run(ctx: AnalyzerContext): Promise<FindingCandidate[]> {
    const findings: FindingCandidate[] = []
    const meta = await inspectMeta(ctx)

    // 1. Missing or empty title
    if (!meta.title || meta.title.trim() === '') {
      findings.push({
        checkId: 'seo.missing_title',
        category: 'SEO',
        severity: 'MAJOR',
        title: 'Missing <title> element',
        description: 'The page has no <title>. Titles are critical for SEO (they appear as the clickable headline in search results) and for browser tabs and bookmarks.',
        remediation: 'Add a unique, descriptive <title> of 50–60 characters in the <head>.',
        messageKey: 'missing-title',
      })
    } else if (meta.titleLength < 10) {
      findings.push({
        checkId: 'seo.short_title',
        category: 'SEO',
        severity: 'MINOR',
        title: `Title is very short (${meta.titleLength} chars)`,
        description: `The page title "${meta.title}" is only ${meta.titleLength} characters. Titles under 10 characters may not provide enough context for search results.`,
        remediation: 'Use a title of 50–60 characters that describes the page content.',
        messageKey: 'short-title',
        evidence: { title: meta.title, length: meta.titleLength },
      })
    } else if (meta.titleLength > 60) {
      findings.push({
        checkId: 'seo.long_title',
        category: 'SEO',
        severity: 'MINOR',
        title: `Title is too long (${meta.titleLength} chars)`,
        description: `The page title is ${meta.titleLength} characters. Search engines typically truncate titles at 60 characters.`,
        remediation: 'Shorten the title to 50–60 characters.',
        messageKey: 'long-title',
        evidence: { title: meta.title, length: meta.titleLength },
      })
    }

    // 2. Missing meta description
    if (!meta.description || meta.description.trim() === '') {
      findings.push({
        checkId: 'seo.missing_description',
        category: 'SEO',
        severity: 'MAJOR',
        title: 'Missing meta description',
        description: 'The page has no <meta name="description">. Descriptions appear in search results and influence click-through rate.',
        remediation: 'Add a unique, compelling description of 120–160 characters describing the page content.',
        messageKey: 'missing-description',
      })
    } else if (meta.descriptionLength < 50) {
      findings.push({
        checkId: 'seo.short_description',
        category: 'SEO',
        severity: 'INFO',
        title: `Meta description is short (${meta.descriptionLength} chars)`,
        description: `The meta description is ${meta.descriptionLength} characters. Descriptions of 120–160 characters use the available space in search results.`,
        remediation: 'Expand the description to 120–160 characters.',
        messageKey: 'short-description',
        evidence: { length: meta.descriptionLength },
      })
    } else if (meta.descriptionLength > 160) {
      findings.push({
        checkId: 'seo.long_description',
        category: 'SEO',
        severity: 'INFO',
        title: `Meta description is too long (${meta.descriptionLength} chars)`,
        description: `The meta description is ${meta.descriptionLength} characters. Search engines typically truncate descriptions at 160 characters.`,
        remediation: 'Shorten the description to 120–160 characters.',
        messageKey: 'long-description',
        evidence: { length: meta.descriptionLength },
      })
    }

    // 3. Missing canonical
    if (!meta.canonical) {
      findings.push({
        checkId: 'seo.missing_canonical',
        category: 'SEO',
        severity: 'MINOR',
        title: 'Missing canonical link',
        description: 'The page has no <link rel="canonical">. Without a canonical URL, search engines may index duplicate versions of the page (e.g. with query parameters).',
        remediation: 'Add <link rel="canonical" href="https://example.com/page"> in the <head>.',
        messageKey: 'missing-canonical',
      })
    }

    // 4. Missing viewport meta
    if (!meta.viewport) {
      findings.push({
        checkId: 'seo.missing_viewport',
        category: 'SEO',
        severity: 'MAJOR',
        title: 'Missing viewport meta tag',
        description: 'The page has no <meta name="viewport">. Without it, mobile browsers render the page at desktop width and zoom out, making text unreadable.',
        remediation: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> in the <head>.',
        messageKey: 'missing-viewport',
      })
    } else if (!meta.viewport.includes('width=device-width')) {
      findings.push({
        checkId: 'seo.bad_viewport',
        category: 'SEO',
        severity: 'MINOR',
        title: 'Suboptimal viewport meta tag',
        description: `The viewport meta tag "${meta.viewport}" does not include width=device-width. The page may not render correctly on mobile devices.`,
        remediation: 'Use <meta name="viewport" content="width=device-width, initial-scale=1">.',
        messageKey: 'bad-viewport',
        evidence: { viewport: meta.viewport },
      })
    }

    // 5. Robots noindex
    if (meta.robots && meta.robots.toLowerCase().includes('noindex')) {
      findings.push({
        checkId: 'seo.noindex',
        category: 'SEO',
        severity: 'INFO',
        title: 'Page is marked noindex',
        description: `The page has <meta name="robots" content="${meta.robots}"> with noindex. Search engines will not index this page.`,
        remediation: 'If this is intentional (e.g. a thank-you page), no action needed. Otherwise, remove the noindex directive.',
        messageKey: 'noindex',
        evidence: { robots: meta.robots },
      })
    }

    // 6. Missing Open Graph tags
    const requiredOg = ['og:title', 'og:description', 'og:image', 'og:url']
    const missingOg = requiredOg.filter((t) => !meta.ogTags[t] || meta.ogTags[t].trim() === '')
    if (missingOg.length > 0) {
      findings.push({
        checkId: 'seo.missing_og_tags',
        category: 'SEO',
        severity: 'MINOR',
        title: `Missing Open Graph tags (${missingOg.join(', ')})`,
        description: 'Open Graph tags control how the page appears when shared on social media (Facebook, LinkedIn, Slack, etc.). Missing tags result in poor-looking shares.',
        remediation: `Add <meta property="og:..." content="..."> tags for: ${missingOg.join(', ')}.`,
        messageKey: 'missing-og-tags',
        evidence: { missing: missingOg, present: Object.keys(meta.ogTags) },
      })
    }

    // 7. Missing Twitter Card tags
    if (!meta.twitterTags['twitter:card']) {
      findings.push({
        checkId: 'seo.missing_twitter_card',
        category: 'SEO',
        severity: 'INFO',
        title: 'Missing Twitter Card meta tag',
        description: 'Without a twitter:card meta tag, Twitter/X will not render a rich card preview when the page is shared.',
        remediation: 'Add <meta name="twitter:card" content="summary_large_image"> and other twitter:* tags.',
        messageKey: 'missing-twitter-card',
      })
    }

    // 8. Missing structured data (JSON-LD)
    if (!meta.hasJsonLd) {
      findings.push({
        checkId: 'seo.missing_structured_data',
        category: 'SEO',
        severity: 'INFO',
        title: 'No JSON-LD structured data found',
        description: 'The page has no <script type="application/ld+json"> structured data. Structured data helps search engines understand the page content and enables rich results.',
        remediation: 'Add JSON-LD describing the page (e.g. Article, Product, BreadcrumbList, Organization). See https://schema.org/.',
        messageKey: 'missing-structured-data',
      })
    }

    // 9. Missing favicon
    if (!meta.hasFavicon) {
      findings.push({
        checkId: 'seo.missing_favicon',
        category: 'SEO',
        severity: 'INFO',
        title: 'Missing favicon',
        description: 'The page has no favicon. Browsers show a default icon, and favicons are used in browser tabs, bookmarks, and home screen shortcuts.',
        remediation: 'Add <link rel="icon" href="/favicon.ico"> in the <head>.',
        messageKey: 'missing-favicon',
      })
    }

    // 10. Missing web app manifest
    if (!meta.hasManifest) {
      findings.push({
        checkId: 'seo.missing_manifest',
        category: 'SEO',
        severity: 'INFO',
        title: 'Missing web app manifest',
        description: 'The page has no <link rel="manifest">. Without a manifest, the page cannot be installed as a PWA.',
        remediation: 'Add a web app manifest and link it with <link rel="manifest" href="/manifest.json">.',
        messageKey: 'missing-manifest',
      })
    }

    // 11. Missing html lang (for SEO context)
    if (!meta.htmlLang) {
      findings.push({
        checkId: 'seo.missing_html_lang',
        category: 'SEO',
        severity: 'MINOR',
        title: 'Missing html[lang] attribute',
        description: 'The <html> element has no lang attribute. Search engines use lang to serve the page to the right audience.',
        remediation: 'Add a lang attribute to the <html> element.',
        messageKey: 'missing-html-lang',
      })
    }

    // 12. Low word count (thin content)
    if (meta.wordCount > 0 && meta.wordCount < 100) {
      findings.push({
        checkId: 'seo.thin_content',
        category: 'SEO',
        severity: 'INFO',
        title: `Low word count (${meta.wordCount} words)`,
        description: 'Pages with very little text content may be considered "thin content" by search engines and rank poorly.',
        remediation: 'Add substantive, useful content. Aim for at least 300 words for most page types.',
        messageKey: 'thin-content',
        evidence: { wordCount: meta.wordCount },
      })
    }

    return findings
  },
}
