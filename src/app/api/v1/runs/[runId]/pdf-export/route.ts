/**
 * POST /api/v1/runs/[runId]/pdf-export
 *
 * Generate and download a professional PDF report for a scan run.
 *
 * Permission: `runs.read`
 *
 * Body:
 *   {
 *     "reportType": "TECHNICAL" | "CLIENT",  // required
 *     "locale": "en" | "fa"                   // optional, overrides project locale
 *   }
 *
 * Response 200 (binary PDF):
 *   Content-Type: application/pdf
 *   Content-Disposition: attachment; filename="proofpilot-technical-project-runid.pdf"
 *
 * 404 if the run does not exist in the workspace.
 * 422 if validation fails.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { assertCsrf } from '@/lib/csrf'
import { requireWorkspaceAuth } from '@/lib/auth-context'
import { generatePdfReport, type PdfReportType } from '@/lib/reports/pdf-export'
import { generateTechnicalReport, generateClientFacingReport } from '@/lib/reports/technical-report'
import { db } from '@/lib/db'
import { problemResponse, newRequestId, NotFoundError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

const pdfExportSchema = z.object({
  reportType: z.enum(['TECHNICAL', 'CLIENT']),
  locale: z.string().max(10).optional(),
})

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const { runId } = await params

    // Validate run exists and get workspace
    const run = await db.scanRun.findUnique({
      where: { id: runId },
      select: { workspaceId: true },
    })
    if (!run) throw new NotFoundError('Run')
    const auth = await requireWorkspaceAuth(run.workspaceId, 'runs.read')

    // Parse body
    const text = await request.text()
    const body = pdfExportSchema.parse(JSON.parse(text || '{}'))

    // Generate the report data
    const reportData = body.reportType === 'CLIENT'
      ? await generateClientFacingReport({ runId, workspaceId: run.workspaceId })
      : await generateTechnicalReport({ runId, workspaceId: run.workspaceId }).then((r) => r.report)

    // Generate PDF
    const pdfResult = await generatePdfReport({
      report: reportData,
      reportType: body.reportType as PdfReportType,
      locale: body.locale,
    })

    // Return PDF as binary download
    return new NextResponse(pdfResult.buffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${pdfResult.filename}"`,
        'Content-Length': String(pdfResult.buffer.length),
        'X-Request-Id': requestId,
        'X-Pdf-Page-Count': String(pdfResult.pageCount),
        'X-Pdf-Generated-At': pdfResult.generatedAt,
      },
    })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
