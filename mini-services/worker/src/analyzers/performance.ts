/**
 * Performance analyzer — ProofPilot worker (Phase 5)
 *
 * Detects:
 *   - Slow TTFB (> 600ms is poor per Web Vitals)
 *   - Slow DOM Content Loaded (> 3s)
 *   - Slow load event (> 5s)
 *   - Poor LCP (> 4s)
 *   - Poor CLS (> 0.25)
 *   - Poor INP (> 500ms)
 *   - Large total transferred bytes (> 3MB)
 *   - Excessive request count (> 100)
 *   - Long tasks (> 50ms count)
 *   - Render-blocking resources
 *
 * Metrics are collected by the runner via Performance Timeline + PerformanceObserver,
 * passed in via ctx.perf.
 *
 * The analyzer also writes ScanPageMetric (via the runner) for the dashboard.
 */
import type { Analyzer, AnalyzerContext, FindingCandidate } from './types'

/** Thresholds (Lighthouse / Web Vitals aligned). */
const THRESHOLDS = {
  ttfbGood: 200,
  ttfbPoor: 600,
  dclGood: 1200,
  dclPoor: 3000,
  loadGood: 2500,
  loadPoor: 5000,
  lcpGood: 2500,
  lcpPoor: 4000,
  clsGood: 0.1,
  clsPoor: 0.25,
  inpGood: 200,
  inpPoor: 500,
  fcpGood: 1800,
  fcpPoor: 3000,
  totalBytesGood: 1_500_000,
  totalBytesPoor: 3_000_000,
  requestCountGood: 50,
  requestCountPoor: 100,
  longTaskMs: 50,
  longTaskCountPoor: 10,
  renderBlockingPoor: 3,
}

function severityFor(value: number, good: number, poor: number): 'INFO' | 'MINOR' | 'MAJOR' {
  if (value <= good) return 'INFO'
  if (value >= poor) return 'MAJOR'
  return 'MINOR'
}

export const performanceAnalyzer: Analyzer = {
  id: 'performance',
  category: 'PERFORMANCE',
  async run(ctx: AnalyzerContext): Promise<FindingCandidate[]> {
    const findings: FindingCandidate[] = []
    const { perf, responses } = ctx

    // 1. TTFB
    if (perf.ttfb !== undefined) {
      const sev = severityFor(perf.ttfb, THRESHOLDS.ttfbGood, THRESHOLDS.ttfbPoor)
      if (sev !== 'INFO') {
        findings.push({
          checkId: 'perf.slow_ttfb',
          category: 'PERFORMANCE',
          severity: sev,
          title: `Slow Time to First Byte (${Math.round(perf.ttfb)}ms)`,
          description: `TTFB is ${Math.round(perf.ttfb)}ms. ${perf.ttfb >= THRESHOLDS.ttfbPoor ? 'Users perceive this as laggy.' : 'This is in the "needs improvement" range.'} Good is < ${THRESHOLDS.ttfbGood}ms.`,
          remediation: 'Optimize server response time: use a CDN, cache database queries, enable HTTP/2 or HTTP/3, and consider edge rendering.',
          messageKey: 'slow-ttfb',
          evidence: { ttfb: perf.ttfb },
        })
      }
    }

    // 2. DCL
    if (perf.domContentLoaded !== undefined) {
      const sev = severityFor(perf.domContentLoaded, THRESHOLDS.dclGood, THRESHOLDS.dclPoor)
      if (sev !== 'INFO') {
        findings.push({
          checkId: 'perf.slow_dcl',
          category: 'PERFORMANCE',
          severity: sev,
          title: `Slow DOM Content Loaded (${Math.round(perf.domContentLoaded)}ms)`,
          description: `DCL is ${Math.round(perf.domContentLoaded)}ms. This measures when the HTML is fully parsed.`,
          remediation: 'Reduce HTML size, defer non-critical scripts, and avoid render-blocking resources.',
          messageKey: 'slow-dcl',
          evidence: { dcl: perf.domContentLoaded },
        })
      }
    }

    // 3. Load event
    if (perf.loadEvent !== undefined) {
      const sev = severityFor(perf.loadEvent, THRESHOLDS.loadGood, THRESHOLDS.loadPoor)
      if (sev !== 'INFO') {
        findings.push({
          checkId: 'perf.slow_load',
          category: 'PERFORMANCE',
          severity: sev,
          title: `Slow load event (${Math.round(perf.loadEvent)}ms)`,
          description: `The load event fires at ${Math.round(perf.loadEvent)}ms. This indicates all sub-resources have finished loading.`,
          remediation: 'Reduce the number and size of sub-resources. Lazy-load offscreen images and iframes.',
          messageKey: 'slow-load',
          evidence: { load: perf.loadEvent },
        })
      }
    }

    // 4. LCP
    if (perf.lcp !== undefined) {
      const sev = severityFor(perf.lcp, THRESHOLDS.lcpGood, THRESHOLDS.lcpPoor)
      if (sev !== 'INFO') {
        findings.push({
          checkId: 'perf.poor_lcp',
          category: 'PERFORMANCE',
          severity: sev,
          title: `Poor Largest Contentful Paint (${Math.round(perf.lcp)}ms)`,
          description: `LCP is ${Math.round(perf.lcp)}ms. This measures when the largest visible element renders. Good is < ${THRESHOLDS.lcpGood}ms; poor is > ${THRESHOLDS.lcpPoor}ms.`,
          remediation: 'Prioritize the largest visible element: preload hero images, reduce server response time, and avoid render-blocking CSS/JS.',
          messageKey: 'poor-lcp',
          evidence: { lcp: perf.lcp },
        })
      }
    }

    // 5. CLS
    if (perf.cls !== undefined) {
      const sev = perf.cls <= THRESHOLDS.clsGood ? 'INFO' : perf.cls >= THRESHOLDS.clsPoor ? 'MAJOR' : 'MINOR'
      if (sev !== 'INFO') {
        findings.push({
          checkId: 'perf.poor_cls',
          category: 'PERFORMANCE',
          severity: sev,
          title: `Poor Cumulative Layout Shift (${perf.cls.toFixed(3)})`,
          description: `CLS is ${perf.cls.toFixed(3)}. Layout shifts are jarring for users. Good is < ${THRESHOLDS.clsGood}; poor is > ${THRESHOLDS.clsPoor}.`,
          remediation: 'Always specify width and height on images/videos/ads. Avoid inserting content above existing content. Use CSS aspect-ratio.',
          messageKey: 'poor-cls',
          evidence: { cls: perf.cls },
        })
      }
    }

    // 6. INP
    if (perf.inp !== undefined) {
      const sev = severityFor(perf.inp, THRESHOLDS.inpGood, THRESHOLDS.inpPoor)
      if (sev !== 'INFO') {
        findings.push({
          checkId: 'perf.poor_inp',
          category: 'PERFORMANCE',
          severity: sev,
          title: `Poor Interaction to Next Paint (${Math.round(perf.inp)}ms)`,
          description: `INP is ${Math.round(perf.inp)}ms. This measures responsiveness to user input. Good is < ${THRESHOLDS.inpGood}ms; poor is > ${THRESHOLDS.inpPoor}ms.`,
          remediation: 'Break up long tasks, defer non-critical JavaScript, and use requestIdleCallback for background work.',
          messageKey: 'poor-inp',
          evidence: { inp: perf.inp },
        })
      }
    }

    // 7. FCP
    if (perf.fcp !== undefined) {
      const sev = severityFor(perf.fcp, THRESHOLDS.fcpGood, THRESHOLDS.fcpPoor)
      if (sev !== 'INFO') {
        findings.push({
          checkId: 'perf.slow_fcp',
          category: 'PERFORMANCE',
          severity: sev,
          title: `Slow First Contentful Paint (${Math.round(perf.fcp)}ms)`,
          description: `FCP is ${Math.round(perf.fcp)}ms. This measures when the first content appears.`,
          remediation: 'Inline critical CSS, preload important resources, and reduce server response time.',
          messageKey: 'slow-fcp',
          evidence: { fcp: perf.fcp },
        })
      }
    }

    // 8. Total bytes
    if (perf.totalBytes !== undefined) {
      const sev = severityFor(perf.totalBytes, THRESHOLDS.totalBytesGood, THRESHOLDS.totalBytesPoor)
      if (sev !== 'INFO') {
        const mb = (perf.totalBytes / 1_000_000).toFixed(2)
        findings.push({
          checkId: 'perf.large_payload',
          category: 'PERFORMANCE',
          severity: sev,
          title: `Large total transferred (${mb}MB)`,
          description: `The page transferred ${(perf.totalBytes / 1000).toFixed(0)}KB across all resources. This slows load on mobile networks.`,
          remediation: 'Compress assets (Brotli/gzip), use modern image formats (WebP/AVIF), lazy-load offscreen resources, and reduce JavaScript bundle size.',
          messageKey: 'large-payload',
          evidence: { totalBytes: perf.totalBytes, largest: perf.largestResources?.slice(0, 5) },
        })
      }
    }

    // 9. Request count
    if (perf.requestCount !== undefined) {
      const sev = severityFor(perf.requestCount, THRESHOLDS.requestCountGood, THRESHOLDS.requestCountPoor)
      if (sev !== 'INFO') {
        findings.push({
          checkId: 'perf.excessive_requests',
          category: 'PERFORMANCE',
          severity: sev,
          title: `Excessive requests (${perf.requestCount})`,
          description: `The page made ${perf.requestCount} network requests. Each request adds latency.`,
          remediation: 'Bundle assets, use HTTP/2 multiplexing, inline small resources, and use icon fonts or sprites for small images.',
          messageKey: 'excessive-requests',
          evidence: { requestCount: perf.requestCount },
        })
      }
    }

    // 10. Long tasks
    if (perf.longTasks !== undefined && perf.longTasks > 0) {
      const sev = perf.longTasks >= THRESHOLDS.longTaskCountPoor ? 'MAJOR' : 'MINOR'
      findings.push({
        checkId: 'perf.long_tasks',
        category: 'PERFORMANCE',
        severity: sev,
        title: `${perf.longTasks} long task${perf.longTasks === 1 ? '' : 's'} (> ${THRESHOLDS.longTaskMs}ms)`,
        description: `${perf.longTasks} task(s) ran for more than ${THRESHOLDS.longTaskMs}ms, blocking the main thread and delaying interaction.`,
        remediation: 'Break up long tasks with setTimeout / requestIdleCallback, defer non-critical JavaScript, and use web workers for CPU-heavy work.',
        messageKey: 'long-tasks',
        evidence: { count: perf.longTasks },
      })
    }

    // 11. Render-blocking resources
    if (perf.renderBlocking !== undefined && perf.renderBlocking > 0) {
      const sev = perf.renderBlocking >= THRESHOLDS.renderBlockingPoor ? 'MAJOR' : 'MINOR'
      findings.push({
        checkId: 'perf.render_blocking',
        category: 'PERFORMANCE',
        severity: sev,
        title: `${perf.renderBlocking} render-blocking resource${perf.renderBlocking === 1 ? '' : 's'}`,
        description: `${perf.renderBlocking} resource(s) block the first render. These are typically <script> without defer/async or <link rel="stylesheet"> in the <head>.`,
        remediation: 'Add defer or async to non-critical scripts. Inline critical CSS and load the rest asynchronously.',
        messageKey: 'render-blocking',
        evidence: { count: perf.renderBlocking },
      })
    }

    // 12. Large individual resources (informational — surface top 3)
    if (perf.largestResources && perf.largestResources.length > 0) {
      const large = perf.largestResources.filter((r) => r.sizeBytes > 250_000).slice(0, 3)
      for (const r of large) {
        findings.push({
          checkId: 'perf.large_resource',
          category: 'PERFORMANCE',
          severity: 'INFO',
          title: `Large resource: ${(r.sizeBytes / 1000).toFixed(0)}KB (${r.type})`,
          description: `Resource ${r.url} is ${(r.sizeBytes / 1000).toFixed(0)}KB. Consider compressing, lazy-loading, or removing it.`,
          messageKey: `large-resource-${r.type}`,
          evidence: { url: r.url, sizeBytes: r.sizeBytes, type: r.type },
        })
      }
    }

    // Suppress the unused-variable lint for responses (kept for future analyzer extensions)
    void responses

    return findings
  },
}
