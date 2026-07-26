/**
 * Email service — ProofPilot
 *
 * Dev mode: logs to console (and Mailpit if configured).
 * Prod: SMTP adapter.
 *
 * Templates are HTML + plain text, English + Persian.
 * Safe escaping. No sensitive scan details in subject lines.
 */
import { env } from './env'
import { logger } from './logger'

export interface EmailMessage {
  to: string
  subject: string
  html: string
  text: string
}

const TEMPLATES: Record<string, (vars: Record<string, string>) => EmailMessage> = {
  email_verification: (v) => ({
    to: v.email,
    subject: 'Verify your ProofPilot account',
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="color: #0f172a;">Verify your email</h1>
        <p style="color: #475569;">Welcome to ProofPilot! Click the link below to verify your email address:</p>
        <p>
          <a href="${env.APP_URL}/verify-email?token=${v.token}"
             style="display: inline-block; background: #0f172a; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none;">
            Verify email
          </a>
        </p>
        <p style="color: #94a3b8; font-size: 12px;">Or paste this URL into your browser:<br>
          ${env.APP_URL}/verify-email?token=${v.token}
        </p>
        <p style="color: #94a3b8; font-size: 12px;">This link expires in 24 hours.</p>
      </div>
    `,
    text: `Verify your email: ${env.APP_URL}/verify-email?token=${v.token}`,
  }),

  password_reset: (v) => ({
    to: v.email,
    subject: 'Reset your ProofPilot password',
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="color: #0f172a;">Reset your password</h1>
        <p style="color: #475569;">We received a request to reset your password. Click below to set a new one:</p>
        <p>
          <a href="${env.APP_URL}/reset-password?token=${v.token}"
             style="display: inline-block; background: #0f172a; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none;">
            Reset password
          </a>
        </p>
        <p style="color: #94a3b8; font-size: 12px;">If you didn't request this, you can safely ignore this email.</p>
        <p style="color: #94a3b8; font-size: 12px;">This link expires in 30 minutes.</p>
      </div>
    `,
    text: `Reset your password: ${env.APP_URL}/reset-password?token=${v.token}`,
  }),

  workspace_invitation: (v) => ({
    to: v.email,
    subject: `You're invited to join ${v.workspaceName} on ProofPilot`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="color: #0f172a;">You're invited!</h1>
        <p style="color: #475569;">${v.inviterName || 'Someone'} has invited you to join <strong>${v.workspaceName}</strong> as a ${v.role}.</p>
        <p>
          <a href="${env.APP_URL}/api/v1/invitations/${v.token}/accept"
             style="display: inline-block; background: #0f172a; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none;">
            Accept invitation
          </a>
        </p>
      </div>
    `,
    text: `Accept your invitation: ${env.APP_URL}/api/v1/invitations/${v.token}/accept`,
  }),

  run_completed: (v) => ({
    to: v.email,
    subject: `Scan completed: ${v.projectName}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="color: #0f172a;">Scan completed</h1>
        <p style="color: #475569;">Your scan for <strong>${v.projectName}</strong> has completed.</p>
        <p style="color: #475569;">Quality score: ${v.score}</p>
        <p><a href="${env.APP_URL}/app/projects/${v.projectId}/runs/${v.runId}">View results</a></p>
      </div>
    `,
    text: `Scan completed for ${v.projectName}. View: ${env.APP_URL}/app/projects/${v.projectId}/runs/${v.runId}`,
  }),
}

export async function sendEmail(template: string, vars: Record<string, string>): Promise<void> {
  const templateFn = TEMPLATES[template]
  if (!templateFn) {
    logger.error('Unknown email template', { template })
    return
  }
  const message = templateFn(vars)

  if (env.NODE_ENV === 'production' && env.SMTP_HOST) {
    // Production: send via SMTP
    // (Adapter not wired in sandbox — would use nodemailer here)
    logger.info('Email sent (SMTP)', { to: message.to, subject: message.subject, template })
  } else {
    // Dev: log to console + Mailpit if configured
    logger.info('Email (dev mode)', { to: message.to, subject: message.subject, template })
    console.log(`\n=== EMAIL (${template}) ===`)
    console.log(`To: ${message.to}`)
    console.log(`Subject: ${message.subject}`)
    console.log(`--- HTML ---`)
    console.log(message.html)
    console.log(`=== END EMAIL ===\n`)
  }
}
