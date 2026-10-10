// ----------------------------------------------------------------
// mailService.ts — production SMTP delivery (nodemailer).
// Never log SMTP_PASS, passwords, or reset tokens.
// ----------------------------------------------------------------

import nodemailer from "nodemailer"

export type SmtpStatus = {
  configured: boolean
  host: string | null
  port: number | null
  secure: boolean
  userPresent: boolean
  passPresent: boolean
  mailFrom: string | null
}

function envTrim(key: string): string {
  return (process.env[key] ?? "").trim()
}

export function getSmtpStatus(): SmtpStatus {
  const host = envTrim("SMTP_HOST") || null
  const portRaw = envTrim("SMTP_PORT")
  const port = portRaw ? Number(portRaw) : host ? 587 : null
  const secureEnv = envTrim("SMTP_SECURE").toLowerCase()
  const secure =
    secureEnv === "true" ||
    secureEnv === "1" ||
    (port != null && Number.isFinite(port) && port === 465)
  return {
    configured: Boolean(
      host &&
        envTrim("SMTP_USER") &&
        process.env.SMTP_PASS &&
        String(process.env.SMTP_PASS).length > 0 &&
        envTrim("MAIL_FROM") &&
        port != null &&
        Number.isFinite(port)
    ),
    host,
    port: port != null && Number.isFinite(port) ? port : null,
    secure,
    userPresent: Boolean(envTrim("SMTP_USER")),
    passPresent: Boolean(process.env.SMTP_PASS && String(process.env.SMTP_PASS).length > 0),
    mailFrom: envTrim("MAIL_FROM") || null,
  }
}

export function isSmtpConfigured(): boolean {
  return getSmtpStatus().configured
}

function createTransport() {
  const status = getSmtpStatus()
  if (!status.configured || !status.host || status.port == null) {
    throw new Error("SMTP is not configured")
  }
  return nodemailer.createTransport({
    host: status.host,
    port: status.port,
    secure: status.secure,
    auth: {
      user: envTrim("SMTP_USER"),
      pass: String(process.env.SMTP_PASS),
    },
  })
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/**
 * Send password-reset HTML email. Caller builds the reset URL.
 * Does not log the URL, token, or SMTP credentials.
 */
export async function sendPasswordResetEmail(input: {
  to: string
  resetUrl: string
}): Promise<{ accepted: boolean; messageId: string | null }> {
  const to = input.to.trim().toLowerCase()
  const resetUrl = input.resetUrl.trim()
  if (!to || !to.includes("@")) throw new Error("Invalid recipient")
  if (!resetUrl) throw new Error("resetUrl is required")

  const from = envTrim("MAIL_FROM")
  if (!from) throw new Error("MAIL_FROM is not configured")

  const safeUrl = escapeHtml(resetUrl)
  const subject = "ListJetGo şifrenizi sıfırlayın"
  const text =
    "ListJetGo şifrenizi sıfırlamak için aşağıdaki bağlantıyı kullanın:\n\n" +
    `${resetUrl}\n\n` +
    "Bağlantı 1 saat geçerlidir.\n" +
    "Bu isteği siz yapmadıysanız bu e-postayı görmezden gelebilirsiniz.\n"

  const html =
    `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;line-height:1.5;color:#111;">` +
    `<p>Merhaba,</p>` +
    `<p>ListJetGo hesap şifrenizi sıfırlamak için aşağıdaki düğmeye tıklayın.</p>` +
    `<p style="margin:28px 0;">` +
    `<a href="${safeUrl}" style="display:inline-block;background:#2d7ff9;color:#fff;` +
    `text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:600;">` +
    `Şifremi Sıfırla</a></p>` +
    `<p>Bağlantı 1 saat geçerlidir.</p>` +
    `<p>Bu isteği siz yapmadıysanız bu e-postayı görmezden gelebilirsiniz.</p>` +
    `<p style="color:#666;font-size:12px;word-break:break-all;">` +
    `Düğme çalışmazsa bu bağlantıyı tarayıcınıza yapıştırın:<br>${safeUrl}</p>` +
    `</body></html>`

  const transport = createTransport()
  const info = await transport.sendMail({
    from,
    to,
    subject,
    text,
    html,
  })

  const acceptedList = Array.isArray(info.accepted) ? info.accepted : []
  const accepted =
    acceptedList.length > 0 &&
    acceptedList.some(a => String(a).toLowerCase() === to || String(a).includes(to))

  return {
    accepted: accepted || acceptedList.length > 0,
    messageId: info.messageId ? String(info.messageId) : null,
  }
}
