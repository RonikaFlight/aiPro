/**
 * PDF export service — ProofPilot (Phase 9)
 *
 * Generates professional server-side PDF reports from TechnicalReport
 * or ClientFacingReport data. Uses PDFKit for low-level PDF generation.
 *
 * Features:
 *   - Branded headers/footers with page numbers
 *   - Severity color labels (badge-style)
 *   - Workspace branding (name, logo, accent color)
 *   - Proper page breaks between major sections
 *   - RTL layout support for Persian (fa) locale
 *   - Accessible typography (built-in Helvetica + optional custom fonts)
 *   - Screenshots referenced as placeholder (fetchable via signed artifact URLs)
 *
 * Architecture:
 *   - PDFDocument class wraps PDFKit with consistent layout helpers
 *   - Each report type has its own renderer function
 *   - Sections manage page-break-before and avoid-break-inside logic
 *
 * See spec §21.5 "PDF export".
 */
import PDFDocument from 'pdfkit'
import type { PDFPage } from 'pdfkit'
import type {
  TechnicalReport,
  ClientFacingReport,
  ReportFinding,
} from './technical-report'

// ======================== Types ========================

export type PdfReportType = 'TECHNICAL' | 'CLIENT'

export interface GeneratePdfOptions {
  report: TechnicalReport | ClientFacingReport
  reportType: PdfReportType
  locale?: string
}

export interface GeneratePdfResult {
  /** PDF file as a Buffer. */
  buffer: Buffer
  /** Suggested filename. */
  filename: string
  /** PDF generation timestamp. */
  generatedAt: string
  /** Total page count. */
  pageCount: number
}

/** Branding info extracted from report data. */
interface BrandingInfo {
  brandName: string
  logoUrl: string | null
  accentColor: string | null
  customIntro: string | null
  customFooter: string | null
  brandContactEmail: string | null
  brandContactUrl: string | null
}

// ======================== Constants ========================

const PAGE_WIDTH = 595.28 // A4 width in points
const PAGE_HEIGHT = 841.89 // A4 height in points
const MARGIN = { top: 60, bottom: 60, left: 50, right: 50 }
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN.left - MARGIN.right
const HEADER_HEIGHT = 40
const FOOTER_HEIGHT = 40
const BODY_TOP = MARGIN.top + HEADER_HEIGHT
const BODY_BOTTOM = PAGE_HEIGHT - MARGIN.bottom - FOOTER_HEIGHT

/** Severity → color mapping. */
const SEVERITY_COLORS: Record<string, string> = {
  BLOCKER: '#dc2626',
  CRITICAL: '#ea580c',
  MAJOR: '#d97706',
  MINOR: '#65a30d',
  INFO: '#6b7280',
}

/** Severity → label mapping. */
const SEVERITY_LABELS: Record<string, string> = {
  BLOCKER: 'Blocker',
  CRITICAL: 'Critical',
  MAJOR: 'Major',
  MINOR: 'Minor',
  INFO: 'Info',
}

/** Finding status → color. */
const STATUS_COLORS: Record<string, string> = {
  OPEN: '#dc2626',
  ACKNOWLEDGED: '#ea580c',
  IN_PROGRESS: '#2563eb',
  RESOLVED: '#16a34a',
  REOPENED: '#dc2626',
  IGNORED: '#6b7280',
  ACCEPTED_RISK: '#d97706',
  FALSE_POSITIVE: '#9ca3af',
}

// ======================== Helpers ========================

function isRtl(locale: string): boolean {
  return locale === 'fa' || locale === 'ar' || locale === 'he' || locale === 'ur'
}

function extractBranding(report: TechnicalReport | ClientFacingReport): BrandingInfo {
  if ('branding' in report && (report as ClientFacingReport).branding) {
    const client = report as ClientFacingReport
    return {
      brandName: client.branding.brandName,
      logoUrl: client.branding.logoUrl,
      accentColor: client.branding.accentColor,
      customIntro: client.branding.customIntro,
      customFooter: client.branding.customFooter,
      brandContactEmail: client.branding.brandContactEmail,
      brandContactUrl: client.branding.brandContactUrl,
    }
  }
  const tech = report as TechnicalReport
  return {
    brandName: tech.project.workspace.brandName ?? tech.project.workspace.name,
    logoUrl: tech.project.workspace.logoUrl,
    accentColor: tech.project.workspace.accentColor,
    customIntro: tech.project.workspace.brandIntro,
    customFooter: tech.project.workspace.brandFooter,
    brandContactEmail: tech.project.workspace.brandContactEmail,
    brandContactUrl: tech.project.workspace.brandContactUrl,
  }
}

function getPrimaryLocale(report: TechnicalReport | ClientFacingReport): string {
  if ('project' in report) {
    return (report as TechnicalReport).project.primaryLocale
  }
  return 'en'
}

function formatDate(isoString: string | null): string {
  if (!isoString) return '—'
  const d = new Date(isoString)
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatDuration(ms: number | null): string {
  if (!ms) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen - 3) + '...'
}

// ======================== PDF Builder ========================

/**
 * Wraps PDFKit with ProofPilot's branded layout: headers, footers,
 * page numbers, severity badges, and RTL support.
 */
class BrandedPdfBuilder {
  private doc: PDFDocument
  private rtl: boolean
  private branding: BrandingInfo
  private accentColor: string
  private pageCount = 0
  private filename: string

  constructor(options: GeneratePdfOptions) {
    const { report, reportType } = options
    this.branding = extractBranding(report)
    this.accentColor = this.branding.accentColor ?? '#2563eb'
    this.rtl = isRtl(getPrimaryLocale(report))

    this.doc = new PDFDocument({
      size: 'A4',
      margins: { top: MARGIN.top, bottom: MARGIN.bottom, left: MARGIN.left, right: MARGIN.right },
      bufferPages: true, // Buffer all pages so we can add headers/footers after
      info: {
        Title: `${reportType} Report`,
        Author: this.branding.brandName,
        Subject: 'ProofPilot Quality Assurance Report',
        Creator: 'ProofPilot',
        Producer: 'ProofPilot PDF Export',
        CreationDate: new Date(),
      },
    })

    const runName = 'run' in report ? (report as TechnicalReport).run.id.slice(0, 8) : ''
    const projectName = 'project' in report
      ? (report as TechnicalReport).project.name
      : 'Report'
    this.filename = `proofpilot-${reportType.toLowerCase()}-${projectName.replace(/\s+/g, '-').toLowerCase()}-${runName}.pdf`
  }

  /** Get the underlying PDFDocument. */
  getDocument(): PDFDocument {
    return this.doc
  }

  /** Get the generated buffer. Must call finalize() first. */
  async finalize(): Promise<Buffer> {
    // Add headers and footers to all buffered pages
    const range = this.doc.bufferedPageRange()
    for (let i = range.start; i < range.start + range.count; i++) {
      this.doc.switchToPage(i)
      this.drawHeader(i)
      this.drawFooter(i, range.count)
    }
    this.pageCount = range.count
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      this.doc.on('data', (chunk: Buffer) => chunks.push(chunk))
      this.doc.on('end', () => resolve(Buffer.concat(chunks)))
      this.doc.on('error', reject)
      this.doc.end()
    })
  }

  getResult(): Omit<GeneratePdfResult, 'buffer'> & { finalize: () => Promise<Buffer> } {
    return {
      filename: this.filename,
      generatedAt: new Date().toISOString(),
      pageCount: this.pageCount,
      finalize: () => this.finalize(),
    }
  }

  // ---------- Page lifecycle ----------

  /** Add a new page with proper margins. */
  addPage(): void {
    this.doc.addPage()
  }

  /** Check remaining space and add a new page if needed. */
  ensureSpace(neededPoints: number): void {
    const cursorY = (this.doc as unknown as { y: number }).y
    if (cursorY + neededPoints > BODY_BOTTOM) {
      this.addPage()
    }
  }

  /** Add a new page (section break). */
  sectionBreak(): void {
    this.addPage()
  }

  // ---------- Headers & Footers ----------

  private drawHeader(pageIndex: number): void {
    const page = (this.doc as unknown as { bufferedPages: PDFPage[] }).bufferedPages[pageIndex]
    if (!page) return

    this.doc.save()
    // Header line
    this.doc
      .moveTo(MARGIN.left, MARGIN.top + HEADER_HEIGHT)
      .lineTo(PAGE_WIDTH - MARGIN.right, MARGIN.top + HEADER_HEIGHT)
      .strokeColor(this.accentColor)
      .lineWidth(1.5)
      .stroke()

    // Brand name on the left (or right for RTL)
    const brandX = this.rtl ? PAGE_WIDTH - MARGIN.right : MARGIN.left
    const align = this.rtl ? 'right' as const : 'left' as const
    this.doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor(this.accentColor)
      .text(this.branding.brandName, brandX, MARGIN.top + 10, {
        width: CONTENT_WIDTH * 0.5,
        align,
      })

    // "ProofPilot Report" label
    const labelX = this.rtl ? MARGIN.left : PAGE_WIDTH - MARGIN.right
    const labelAlign = this.rtl ? 'left' as const : 'right' as const
    this.doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#9ca3af')
      .text('ProofPilot Quality Report', labelX, MARGIN.top + 12, {
        width: CONTENT_WIDTH * 0.4,
        align: labelAlign,
      })

    this.doc.restore()
  }

  private drawFooter(pageIndex: number, totalPages: number): void {
    const footerY = PAGE_HEIGHT - MARGIN.bottom - FOOTER_HEIGHT + 15

    this.doc.save()
    // Footer line
    this.doc
      .moveTo(MARGIN.left, footerY - 5)
      .lineTo(PAGE_WIDTH - MARGIN.right, footerY - 5)
      .strokeColor('#e5e7eb')
      .lineWidth(0.5)
      .stroke()

    // Page number (center)
    this.doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#9ca3af')
      .text(
        `Page ${pageIndex + 1} of ${totalPages}`,
        MARGIN.left,
        footerY,
        { width: CONTENT_WIDTH, align: 'center' },
      )

    // Footer text (custom or default)
    const footerText = this.branding.customFooter ?? `Generated by ProofPilot — ${formatDate(new Date().toISOString())}`
    const footerAlign = this.rtl ? 'right' as const : 'left' as const
    this.doc
      .font('Helvetica')
      .fontSize(7)
      .fillColor('#d1d5db')
      .text(truncateText(footerText, 100), MARGIN.left, footerY + 12, {
        width: CONTENT_WIDTH,
        align: footerAlign,
      })

    this.doc.restore()
  }

  // ---------- Text helpers ----------

  /** Write a section title with accent color underline. */
  sectionTitle(text: string, fontSize: number = 16): void {
    this.ensureSpace(50)
    this.doc.moveDown(0.5)
    this.doc
      .font('Helvetica-Bold')
      .fontSize(fontSize)
      .fillColor('#111827')
      .text(text, { align: this.rtl ? 'right' : 'left' })
    // Underline
    const cursorY = (this.doc as unknown as { y: number }).y
    this.doc
      .moveTo(this.rtl ? PAGE_WIDTH - MARGIN.right : MARGIN.left, cursorY + 2)
      .lineTo(this.rtl ? MARGIN.left : PAGE_WIDTH - MARGIN.right, cursorY + 2)
      .strokeColor(this.accentColor)
      .lineWidth(1)
      .stroke()
    this.doc.moveDown(0.5)
  }

  /** Write a subsection title. */
  subTitle(text: string): void {
    this.ensureSpace(30)
    this.doc.moveDown(0.3)
    this.doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .fillColor('#374151')
      .text(text, { align: this.rtl ? 'right' : 'left' })
    this.doc.moveDown(0.3)
  }

  /** Write body text. */
  bodyText(text: string, fontSize: number = 10): void {
    this.doc
      .font('Helvetica')
      .fontSize(fontSize)
      .fillColor('#374151')
      .text(text, {
        align: this.rtl ? 'right' : 'left',
        lineGap: 3,
      })
  }

  /** Write a labeled value pair. */
  labelValue(label: string, value: string): void {
    this.ensureSpace(18)
    const startX = this.rtl ? PAGE_WIDTH - MARGIN.right : MARGIN.left
    const labelWidth = CONTENT_WIDTH * 0.35
    const valueWidth = CONTENT_WIDTH * 0.65
    const labelX = this.rtl ? startX - labelWidth : startX
    const valueX = this.rtl ? startX : startX + labelWidth

    this.doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor('#6b7280')
      .text(`${label}:`, labelX, undefined, {
        width: labelWidth,
        align: this.rtl ? 'right' : 'left',
        continued: false,
      })

    this.doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#111827')
      .text(truncateText(value, 80), valueX, (this.doc as unknown as { y: number }).y - 13, {
        width: valueWidth,
        align: this.rtl ? 'right' : 'left',
      })
  }

  /** Draw a severity badge. */
  severityBadge(severity: string): void {
    const color = SEVERITY_COLORS[severity] ?? '#6b7280'
    const label = SEVERITY_LABELS[severity] ?? severity
    const y = (this.doc as unknown as { y: number }).y + 1
    const x = this.rtl ? PAGE_WIDTH - MARGIN.right - 5 : MARGIN.left - 5
    const w = this.doc.widthOfString(label, { font: 'Helvetica-Bold', size: 7 }) + 12

    // Badge background
    this.doc
      .save()
      .roundedRect(x, y, w, 14, 3)
      .fill(color)
      .fillColor('#ffffff')
      .font('Helvetica-Bold')
      .fontSize(7)
      .text(label.toUpperCase(), x + 6, y + 3, { width: w - 12, align: 'center' })
      .restore()

    // Advance cursor past badge
    const newY = y + 16
    ;(this.doc as unknown as { y: number }).y = newY
  }

  /** Draw a status pill. */
  statusPill(status: string): void {
    const color = STATUS_COLORS[status] ?? '#6b7280'
    const y = (this.doc as unknown as { y: number }).y + 1
    const x = this.rtl ? PAGE_WIDTH - MARGIN.right - 5 : MARGIN.left - 5
    const w = this.doc.widthOfString(status.replace(/_/g, ' '), { font: 'Helvetica', size: 7 }) + 12

    this.doc
      .save()
      .roundedRect(x, y, w, 14, 3)
      .fill(color)
      .fillColor('#ffffff')
      .font('Helvetica')
      .fontSize(7)
      .text(status.replace(/_/g, ' '), x + 6, y + 3, { width: w - 12, align: 'center' })
      .restore()

    const newY = y + 16
    ;(this.doc as unknown as { y: number }).y = newY
  }

  /** Draw a data table. */
  table(headers: string[], rows: string[][]): void {
    const colCount = headers.length
    const colWidth = CONTENT_WIDTH / colCount

    this.ensureSpace(25 + rows.length * 18)

    // Header row
    const startY = (this.doc as unknown as { y: number }).y
    this.doc
      .save()
      .rect(MARGIN.left, startY, CONTENT_WIDTH, 18)
      .fill(this.accentColor)

    this.doc.fillColor('#ffffff')
      .font('Helvetica-Bold')
      .fontSize(8)
    for (let i = 0; i < colCount; i++) {
      const x = this.rtl ? PAGE_WIDTH - MARGIN.right - colWidth * (i + 1) : MARGIN.left + colWidth * i
      this.doc.text(truncateText(headers[i], 30), x + 4, startY + 4, {
        width: colWidth - 8,
        align: 'left',
      })
    }
    this.doc.restore()
    ;(this.doc as unknown as { y: number }).y = startY + 20

    // Data rows
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r]
      const rowY = (this.doc as unknown as { y: number }).y

      if (rowY + 16 > BODY_BOTTOM) {
        this.addPage()
        // Repeat header
        const newStartY = BODY_TOP
        this.doc.save()
          .rect(MARGIN.left, newStartY, CONTENT_WIDTH, 18)
          .fill(this.accentColor)
        this.doc.fillColor('#ffffff')
          .font('Helvetica-Bold')
          .fontSize(8)
        for (let i = 0; i < colCount; i++) {
          const x = this.rtl ? PAGE_WIDTH - MARGIN.right - colWidth * (i + 1) : MARGIN.left + colWidth * i
          this.doc.text(truncateText(headers[i], 30), x + 4, newStartY + 4, {
            width: colWidth - 8,
            align: 'left',
          })
        }
        this.doc.restore()
        ;(this.doc as unknown as { y: number }).y = newStartY + 20
      }

      const currentY = (this.doc as unknown as { y: number }).y
      // Alternating row background
      if (r % 2 === 0) {
        this.doc
          .save()
          .rect(MARGIN.left, currentY, CONTENT_WIDTH, 16)
          .fill('#f9fafb')
          .restore()
      }
      // Row border
      this.doc
        .save()
        .moveTo(MARGIN.left, currentY + 16)
        .lineTo(PAGE_WIDTH - MARGIN.right, currentY + 16)
        .strokeColor('#e5e7eb')
        .lineWidth(0.25)
        .stroke()
        .restore()

      this.doc.fillColor('#374151')
        .font('Helvetica')
        .fontSize(7.5)
      for (let i = 0; i < colCount; i++) {
        const x = this.rtl ? PAGE_WIDTH - MARGIN.right - colWidth * (i + 1) : MARGIN.left + colWidth * i
        this.doc.text(truncateText(row[i] ?? '', 35), x + 4, currentY + 4, {
          width: colWidth - 8,
          align: 'left',
        })
      }
      ;(this.doc as unknown as { y: number }).y = currentY + 18
    }
    this.doc.moveDown(0.5)
  }

  /** Draw a metric card (boxed summary). */
  metricCard(label: string, value: string, color?: string): void {
    this.ensureSpace(45)
    const cardWidth = CONTENT_WIDTH
    const cardHeight = 35
    const y = (this.doc as unknown as { y: number }).y

    this.doc
      .save()
      .roundedRect(MARGIN.left, y, cardWidth, cardHeight, 4)
      .fill('#f9fafb')
      .stroke()
      .restore()

    // Accent left border
    this.doc
      .save()
      .rect(MARGIN.left, y, 3, cardHeight)
      .fill(color ?? this.accentColor)
      .restore()

    const textX = MARGIN.left + 14
    this.doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#6b7280')
      .text(label, textX, y + 5, { width: cardWidth - 30, align: this.rtl ? 'right' : 'left' })

    this.doc
      .font('Helvetica-Bold')
      .fontSize(14)
      .fillColor('#111827')
      .text(value, textX, y + 17, { width: cardWidth - 30, align: this.rtl ? 'right' : 'left' })

    ;(this.doc as unknown as { y: number }).y = y + cardHeight + 8
  }

  /** Draw a placeholder for a screenshot. */
  screenshotPlaceholder(label: string, artifactId?: string): void {
    this.ensureSpace(120)
    const boxWidth = CONTENT_WIDTH
    const boxHeight = 80
    const y = (this.doc as unknown as { y: number }).y

    this.doc
      .save()
      .roundedRect(MARGIN.left, y, boxWidth, boxHeight, 4)
      .lineWidth(0.5)
      .dash(3, { space: 3 })
      .strokeColor('#d1d5db')
      .stroke()
      .restore()

    this.doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#9ca3af')
      .text(
        `📷 ${label}${artifactId ? ` (artifact: ${artifactId.slice(0, 8)})` : ''}`,
        MARGIN.left + 10,
        y + boxHeight / 2 - 6,
        { width: boxWidth - 20, align: 'center' },
      )

    ;(this.doc as unknown as { y: number }).y = y + boxHeight + 8
  }
}

// ======================== Report Renderers ========================

/**
 * Render a TechnicalReport into a branded PDF.
 */
function renderTechnicalReport(builder: BrandedPdfBuilder, report: TechnicalReport): void {
  const doc = builder.getDocument()

  // ---- Title page ----
  builder.addPage()
  doc.moveDown(4)
  doc
    .font('Helvetica-Bold')
    .fontSize(24)
    .fillColor('#111827')
    .text('Technical Quality Report', { align: 'center' })
  doc.moveDown(0.5)
  doc
    .font('Helvetica')
    .fontSize(14)
    .fillColor('#6b7280')
    .text(report.project.name, { align: 'center' })
  doc.moveDown(1)
  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor('#9ca3af')
    .text(report.environment?.baseUrl ?? '', { align: 'center' })
  doc.moveDown(2)

  // Score card on title page
  if (report.run.score !== null) {
    const scoreColor = report.run.score >= 80 ? '#16a34a' : report.run.score >= 50 ? '#d97706' : '#dc2626'
    builder.metricCard('Quality Score', `${report.run.score}/100`, scoreColor)
  }

  doc.moveDown(1)
  builder.labelValue('Generated', formatDate(report.meta.generatedAt))
  builder.labelValue('Run Status', report.run.status)
  builder.labelValue('Run Trigger', report.run.trigger)
  builder.labelValue('Run Mode', report.run.runMode)
  builder.labelValue('Duration', formatDuration(report.run.durationMs))
  builder.labelValue('Pages Analyzed', `${report.run.pagesAnalyzed}/${report.run.pagesDiscovered}`)

  if (report.run.aiSummary) {
    doc.moveDown(1)
    builder.sectionTitle('Executive Summary', 14)
    builder.bodyText(report.run.aiSummary)
  }

  // ---- Run & Environment ----
  builder.sectionBreak()
  builder.sectionTitle('Run Configuration')
  builder.labelValue('Max Pages', String(report.config.maxPages))
  builder.labelValue('Max Depth', String(report.config.maxDepth))
  builder.labelValue('Viewports', (report.config.viewports ?? []).join(', ') || 'Default')
  builder.labelValue('Locales', (report.config.locales ?? []).join(', ') || 'Default')
  builder.labelValue('Browsers', (report.config.browsers ?? []).join(', ') || 'Default')
  builder.labelValue('Auth Mode', report.environment?.authMode ?? 'None')

  // ---- Findings Summary ----
  builder.sectionBreak()
  builder.sectionTitle('Findings Summary')

  builder.labelValue('Total Findings', String(report.findings.totalCount))
  builder.labelValue('Blockers', String(report.findings.bySeverity['BLOCKER'] ?? 0))
  builder.labelValue('Critical', String(report.findings.bySeverity['CRITICAL'] ?? 0))
  builder.labelValue('Major', String(report.findings.bySeverity['MAJOR'] ?? 0))
  builder.labelValue('Minor', String(report.findings.bySeverity['MINOR'] ?? 0))
  builder.labelValue('Info', String(report.findings.bySeverity['INFO'] ?? 0))

  doc.moveDown(0.5)

  // Severity breakdown table
  const sevHeaders = ['Severity', 'Count', 'Status Breakdown']
  const sevRows: string[][] = []
  for (const [sev, count] of Object.entries(report.findings.bySeverity)) {
    if (count > 0) {
      sevRows.push([sev, String(count), `${report.findings.byStatus['OPEN'] ?? 0} open`])
    }
  }
  if (sevRows.length > 0) {
    builder.table(sevHeaders, sevRows)
  }

  // Category breakdown
  doc.moveDown(0.5)
  builder.subTitle('By Category')
  const catHeaders = ['Category', 'Count']
  const catRows: string[][] = Object.entries(report.findings.byCategory)
    .filter(([, c]) => c > 0)
    .map(([cat, count]) => [cat.replace(/_/g, ' '), String(count)])
    .sort((a, b) => parseInt(b[1]) - parseInt(a[1]))
  if (catRows.length > 0) {
    builder.table(catHeaders, catRows)
  }

  // ---- Semantic Groups ----
  if (report.findings.semanticGroups && report.findings.semanticGroups.length > 0) {
    doc.moveDown(0.5)
    builder.subTitle('Semantic Groups (AI)')
    for (const group of report.findings.semanticGroups) {
      builder.ensureSpace(25)
      doc.moveDown(0.3)
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#374151')
        .text(`• ${group.label} (${group.findingIds.length} findings)`, {
          align: builder['rtl'] ? 'right' : 'left',
        })
      doc.font('Helvetica').fontSize(8).fillColor('#6b7280')
        .text(`  Root cause: ${truncateText(group.sharedRootCause, 120)}`, {
          align: builder['rtl'] ? 'right' : 'left',
        })
    }
  }

  // ---- Findings Detail ----
  builder.sectionBreak()
  builder.sectionTitle('Findings Detail')

  const sortedFindings = [...report.findings.items].sort((a, b) => {
    const severityOrder = ['BLOCKER', 'CRITICAL', 'MAJOR', 'MINOR', 'INFO']
    const aIdx = severityOrder.indexOf(a.severity)
    const bIdx = severityOrder.indexOf(b.severity)
    return aIdx - bIdx
  })

  for (const finding of sortedFindings) {
    renderFinding(builder, finding)
  }

  // ---- Performance ----
  builder.sectionBreak()
  builder.sectionTitle('Performance Summary')

  if (report.performance.avg.lcp !== null) {
    const lcpColor = report.performance.avg.lcp <= 2500 ? '#16a34a' : report.performance.avg.lcp <= 4000 ? '#d97706' : '#dc2626'
    builder.metricCard('Avg LCP', `${Math.round(report.performance.avg.lcp)}ms`, lcpColor)
  }
  if (report.performance.avg.cls !== null) {
    const clsColor = report.performance.avg.cls <= 0.1 ? '#16a34a' : report.performance.avg.cls <= 0.25 ? '#d97706' : '#dc2626'
    builder.metricCard('Avg CLS', report.performance.avg.cls.toFixed(3), clsColor)
  }
  if (report.performance.avg.inp !== null) {
    const inpColor = report.performance.avg.inp <= 200 ? '#16a34a' : report.performance.avg.inp <= 500 ? '#d97706' : '#dc2626'
    builder.metricCard('Avg INP', `${Math.round(report.performance.avg.inp)}ms`, inpColor)
  }
  if (report.performance.avg.loadEvent !== null) {
    builder.metricCard('Avg Load Time', `${Math.round(report.performance.avg.loadEvent)}ms`)
  }

  if (report.performance.slowestPage) {
    doc.moveDown(0.5)
    builder.subTitle('Slowest Page')
    builder.labelValue('URL', truncateText(report.performance.slowestPage.url, 80))
    builder.labelValue('Title', report.performance.slowestPage.title ?? '—')
    builder.labelValue('Load Time', `${Math.round(report.performance.slowestPage.loadEvent)}ms`)
  }

  doc.moveDown(0.5)
  builder.labelValue('Pages Measured', String(report.performance.pagesMeasured))

  // ---- Accessibility ----
  builder.sectionBreak()
  builder.sectionTitle('Accessibility Summary')

  builder.labelValue('Total A11y Findings', String(report.accessibility.totalA11yFindings))
  const a11yHeaders = ['Severity', 'Count']
  const a11yRows: string[][] = Object.entries(report.accessibility.bySeverity)
    .filter(([, c]) => c > 0)
    .map(([sev, count]) => [sev, String(count)])
  if (a11yRows.length > 0) {
    builder.table(a11yHeaders, a11yRows)
  }

  if (report.accessibility.categories.length > 0) {
    doc.moveDown(0.3)
    builder.bodyText(`Categories found: ${report.accessibility.categories.join(', ')}`)
  }

  // ---- Errors ----
  builder.sectionBreak()
  builder.sectionTitle('Runtime Errors & Issues')

  builder.labelValue('Console Errors', String(report.errors.totalConsoleErrors))
  builder.labelValue('Network Errors', String(report.errors.totalNetworkErrors))
  builder.labelValue('Blocked Requests', String(report.errors.blockedRequests))
  builder.labelValue('Journey Failures', String(report.errors.journeyFailures))

  // ---- Pages ----
  builder.sectionBreak()
  builder.sectionTitle('Pages Tested')

  const pageHeaders = ['Page', 'Status', 'Depth', 'Lang']
  const pageRows: string[][] = report.pages.slice(0, 50).map((p) => [
    truncateText(p.title ?? p.normalizedUrl, 40),
    p.httpStatus ? String(p.httpStatus) : '—',
    String(p.depth),
    p.lang ?? '—',
  ])
  if (pageRows.length > 0) {
    builder.table(pageHeaders, pageRows)
  }

  // ---- Limitations ----
  if (report.limitations.length > 0) {
    builder.sectionBreak()
    builder.sectionTitle('Limitations & Caveats')
    for (const lim of report.limitations) {
      builder.bodyText(`• ${lim}`)
      doc.moveDown(0.2)
    }
  }
}

/**
 * Render a ClientFacingReport into a branded PDF.
 */
function renderClientReport(builder: BrandedPdfBuilder, report: ClientFacingReport): void {
  const doc = builder.getDocument()

  // ---- Title page ----
  builder.addPage()
  doc.moveDown(3)

  // Brand name
  if (report.branding.brandName) {
    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .fillColor(builder['accentColor'])
      .text(report.branding.brandName, { align: 'center' })
    doc.moveDown(0.5)
  }

  doc
    .font('Helvetica-Bold')
    .fontSize(24)
    .fillColor('#111827')
    .text('Quality Assurance Report', { align: 'center' })
  doc.moveDown(1)

  if (report.branding.customIntro) {
    doc
      .font('Helvetica')
      .fontSize(11)
      .fillColor('#6b7280')
      .text(report.branding.customIntro, {
        align: 'center',
        width: CONTENT_WIDTH * 0.8,
        indent: CONTENT_WIDTH * 0.1,
        lineGap: 4,
      })
    doc.moveDown(1.5)
  }

  // Quality score
  if (report.quality.score !== null) {
    const scoreColor = report.quality.score >= 80 ? '#16a34a' : report.quality.score >= 50 ? '#d97706' : '#dc2626'
    builder.metricCard('Quality Score', `${report.quality.score}/100`, scoreColor)
    doc.moveDown(0.5)
  }

  // ---- Executive Summary ----
  builder.sectionBreak()
  builder.sectionTitle('Executive Summary')

  if (report.executive.summary) {
    builder.bodyText(report.executive.summary)
    doc.moveDown(0.5)
  }

  if (report.executive.deliveryReadiness) {
    builder.labelValue('Delivery Readiness', report.executive.deliveryReadiness)
    doc.moveDown(0.3)
  }

  // Positive notes
  if (report.executive.positiveNotes.length > 0) {
    builder.subTitle('Strengths')
    for (const note of report.executive.positiveNotes) {
      builder.bodyText(`✓ ${note}`)
      doc.moveDown(0.15)
    }
  }

  // Attention items
  if (report.executive.attentionItems.length > 0) {
    doc.moveDown(0.5)
    builder.subTitle('Items Requiring Attention')
    for (const item of report.executive.attentionItems) {
      builder.bodyText(`⚠ ${item}`)
      doc.moveDown(0.15)
    }
  }

  // ---- Quality Metrics ----
  builder.sectionBreak()
  builder.sectionTitle('Quality Metrics')

  builder.labelValue('Score', report.quality.score !== null ? `${report.quality.score}/100` : '—')
  if (report.quality.previousScore !== null) {
    const delta = report.quality.scoreDelta
    builder.labelValue('Previous Score', `${report.quality.previousScore}/100`)
    builder.labelValue('Change', delta !== null ? (delta > 0 ? `+${delta}` : String(delta)) : '—')
  }
  builder.labelValue('Tests Completed', String(report.quality.testsCompleted))
  builder.labelValue('Pages Tested', String(report.quality.pagesTested))
  builder.labelValue('Journeys Executed', String(report.quality.journeysExecuted))

  // ---- Issues ----
  builder.sectionBreak()
  builder.sectionTitle('Issues Overview')

  const issuesHeaders = ['Status', 'Count']
  const issuesRows: string[][] = [
    ['Critical Issues', String(report.issues.criticalCount)],
    ['Resolved', String(report.issues.resolvedCount)],
    ['Remaining Risks', String(report.issues.remainingRisks)],
  ]
  builder.table(issuesHeaders, issuesRows)

  // Critical issue details
  if (report.issues.criticalIssues.length > 0) {
    doc.moveDown(0.5)
    builder.subTitle('Critical Issues Detail')

    for (const issue of report.issues.criticalIssues) {
      builder.ensureSpace(40)
      doc.moveDown(0.3)

      // Title with severity badge
      const sevColor = SEVERITY_COLORS[issue.severity] ?? '#6b7280'
      builder.severityBadge(issue.severity)

      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor('#111827')
        .text(truncateText(issue.title, 100), {
          align: builder['rtl'] ? 'right' : 'left',
        })

      if (issue.clientDescription) {
        doc
          .font('Helvetica')
          .fontSize(8)
          .fillColor('#6b7280')
          .text(truncateText(issue.clientDescription, 200), {
            align: builder['rtl'] ? 'right' : 'left',
            lineGap: 2,
          })
      }

      doc
        .font('Helvetica')
        .fontSize(7)
        .fillColor('#9ca3af')
        .text(`Affected: ${truncateText(issue.affectedUrl, 60)}`)

      doc.moveDown(0.3)
    }
  }

  // ---- Limitations ----
  if (report.limitations.length > 0) {
    builder.sectionBreak()
    builder.sectionTitle('Scope & Limitations')
    for (const lim of report.limitations) {
      builder.bodyText(`• ${lim}`)
      doc.moveDown(0.2)
    }
  }

  // ---- Contact ----
  builder.sectionBreak()
  builder.sectionTitle('Contact')

  if (report.branding.brandContactEmail) {
    builder.bodyText(`Email: ${report.branding.brandContactEmail}`)
  }
  if (report.branding.brandContactUrl) {
    builder.bodyText(`Website: ${report.branding.brandContactUrl}`)
  }
  if (!report.branding.brandContactEmail && !report.branding.brandContactUrl) {
    builder.bodyText('For questions about this report, please contact your QA representative.')
  }
}

/**
 * Render a single finding with its details.
 */
function renderFinding(builder: BrandedPdfBuilder, finding: ReportFinding): void {
  builder.ensureSpace(70)
  const doc = builder.getDocument()
  doc.moveDown(0.3)

  // Severity badge
  builder.severityBadge(finding.severity)

  // Title
  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .fillColor('#111827')
    .text(truncateText(finding.title, 120), {
      align: builder['rtl'] ? 'right' : 'left',
    })

  // Status pill (inline)
  builder.statusPill(finding.status)

  doc.moveDown(0.15)

  // Category + URL
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#6b7280')
    .text(`${finding.category.replace(/_/g, ' ')} • ${truncateText(finding.affectedUrl, 80)}`, {
      align: builder['rtl'] ? 'right' : 'left',
    })

  // Description
  if (finding.description) {
    doc.moveDown(0.15)
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#374151')
      .text(truncateText(finding.description, 300), {
        align: builder['rtl'] ? 'right' : 'left',
        lineGap: 2,
      })
  }

  // AI Explanation
  if (finding.aiExplanation) {
    doc.moveDown(0.15)
    doc
      .font('Helvetica-Oblique')
      .fontSize(8)
      .fillColor('#4b5563')
      .text(`AI: ${truncateText(finding.aiExplanation, 250)}`, {
        align: builder['rtl'] ? 'right' : 'left',
        lineGap: 2,
      })
  }

  // AI Remediation
  if (finding.aiRemediation?.summary) {
    doc.moveDown(0.15)
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#2563eb')
      .text(`Fix: ${truncateText(finding.aiRemediation.summary, 200)}`, {
        align: builder['rtl'] ? 'right' : 'left',
        lineGap: 2,
      })
  }

  // Evidence screenshot placeholder
  if (finding.firstOccurrenceScreenshotArtifactId) {
    doc.moveDown(0.2)
    builder.screenshotPlaceholder('Evidence Screenshot', finding.firstOccurrenceScreenshotArtifactId)
  }

  doc.moveDown(0.3)

  // Separator line
  const cursorY = (doc as unknown as { y: number }).y
  doc
    .save()
    .moveTo(MARGIN.left, cursorY)
    .lineTo(PAGE_WIDTH - MARGIN.right, cursorY)
    .strokeColor('#f3f4f6')
    .lineWidth(0.5)
    .stroke()
    .restore()
}

// ======================== Public API ========================

/**
 * Generate a professional PDF report.
 *
 * @param options - Report data + report type + optional locale override
 * @returns Buffer containing the PDF binary data, plus metadata
 *
 * The PDF includes:
 *   - Branded headers/footers on every page
 *   - Page numbers
 *   - Severity color labels (badge-style)
 *   - Workspace branding (name, logo URL placeholder, accent color)
 *   - Proper page breaks between major sections
 *   - RTL text alignment for Persian (fa) locale
 *   - Screenshot placeholders (with artifact IDs for signed URL access)
 *   - No internal check IDs, selector syntax, or console output in client mode
 *
 * For screenshots, the PDF includes placeholders that reference artifact IDs.
 * A future integration with the signed artifact URL system will allow
 * embedding actual images.
 */
export async function generatePdfReport(
  options: GeneratePdfOptions,
): Promise<GeneratePdfResult> {
  const { report, reportType, locale } = options
  const effectiveLocale = locale ?? getPrimaryLocale(report)

  const builder = new BrandedPdfBuilder({
    report,
    reportType,
    locale: effectiveLocale,
  })

  // Render based on report type
  if (reportType === 'CLIENT' && 'branding' in report) {
    renderClientReport(builder, report as ClientFacingReport)
  } else {
    renderTechnicalReport(builder, report as TechnicalReport)
  }

  // Finalize: add headers/footers to all pages, collect buffer
  const result = builder.getResult()
  const buffer = await result.finalize()

  return {
    buffer,
    filename: result.filename,
    generatedAt: result.generatedAt,
    pageCount: result.pageCount,
  }
}
