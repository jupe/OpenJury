import nodemailer from "nodemailer";

/*
 * Server-only email delivery over SMTP, sharing the SMTP_* settings that
 * Supabase Auth uses for sign-in links. Never import this from client code.
 */

export type MailConfig = {
  host: string;
  port: number;
  user: string | undefined;
  pass: string | undefined;
  from: string;
  senderName: string;
};

export type MailMessage = { from: string; to: string[]; subject: string; text: string };

export type MailTransport = {
  sendMail(message: Omit<MailMessage, "from"> & { from: { name: string; address: string } }): Promise<{ messageId?: string; response?: string }>;
  close(): void;
};

const address = /^[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+$/;

/** The SMTP settings, or the reason they are unusable (setting names only, never values). */
export function mailConfiguration(): { error: string } | MailConfig {
  const host = process.env.SMTP_HOST;
  const from = process.env.SMTP_ADMIN_EMAIL;
  const missing = Object.entries({ SMTP_HOST: host, SMTP_ADMIN_EMAIL: from })
    .filter(([, value]) => !value).map(([name]) => name);
  if (missing.length || !host || !from) return { error: `missing ${missing.join(", ")}` };
  if (/[\s/:]/.test(host)) return { error: "SMTP_HOST must be a bare hostname" };
  const port = Number(process.env.SMTP_PORT || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: "SMTP_PORT is invalid" };
  const user = process.env.SMTP_USER || undefined;
  const pass = process.env.SMTP_PASS || undefined;
  if (!user !== !pass) return { error: "SMTP_USER and SMTP_PASS must be set together" };
  if (/[\r\n]/.test(from) || !address.test(from)) return { error: "SMTP_ADMIN_EMAIL is not a bare address" };
  const senderName = (process.env.SMTP_SENDER_NAME || "OpenJury").replace(/[\r\n"<>]/g, " ").trim() || "OpenJury";
  return { host, port, user, pass, from, senderName };
}

/** Replaceable so tests can capture messages without a real SMTP server. */
export const mailer = {
  createTransport(config: MailConfig): MailTransport {
    return nodemailer.createTransport({
      host: config.host,
      port: config.port,
      // 465 is implicit TLS; 587 must upgrade with STARTTLS rather than fall back to plain text.
      secure: config.port === 465,
      requireTLS: config.port === 587,
      auth: config.user && config.pass ? { user: config.user, pass: config.pass } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
    });
  },
};

/** SMTP failures without credentials or recipients: the server's status code and reply. */
export function describeMailError(error: unknown, recipient?: string) {
  const failure = error as { code?: string; responseCode?: number; response?: string; message?: string };
  const redact = (text: string | undefined) =>
    recipient && text ? text.replaceAll(recipient, "<recipient>").slice(0, 500) : text?.slice(0, 500);
  return {
    code: failure?.code,
    responseCode: failure?.responseCode,
    response: redact(failure?.response),
    error: redact(failure?.message ?? String(error)),
  };
}

export async function sendMail(transport: MailTransport, config: MailConfig, message: MailMessage) {
  return transport.sendMail({ ...message, from: { name: config.senderName, address: message.from } });
}
