import nodemailer, { type Transporter } from "nodemailer";

type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  from: string;
  replyTo?: string;
  auth?: { user: string; pass: string };
};

export class EmailDeliveryError extends Error {
  constructor(message = "Email delivery is unavailable") {
    super(message);
    this.name = "EmailDeliveryError";
  }
}

export class EmailConfigurationError extends EmailDeliveryError {
  constructor() {
    super("Email delivery is not configured");
    this.name = "EmailConfigurationError";
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new EmailConfigurationError();
  return value;
}

function booleanEnvironment(name: string, defaultValue: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return defaultValue;
  if (["1", "true"].includes(value)) return true;
  if (["0", "false"].includes(value)) return false;
  throw new EmailConfigurationError();
}

export function smtpConfigFromEnvironment(): SmtpConfig {
  const resendApiKey = process.env.RESEND_API_KEY?.trim();
  const explicitHost = process.env.SMTP_HOST?.trim();
  const explicitPassword = process.env.SMTP_PASSWORD;
  const useResendDefaults = Boolean(
    resendApiKey && !explicitPassword && (!explicitHost || explicitHost === "smtp.resend.com"),
  );
  const host = explicitHost || (useResendDefaults ? "smtp.resend.com" : required("SMTP_HOST"));
  const port = Number(process.env.SMTP_PORT?.trim() || (useResendDefaults ? "465" : required("SMTP_PORT")));
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new EmailConfigurationError();
  }

  const user = process.env.SMTP_USER?.trim() || (useResendDefaults ? "resend" : undefined);
  const pass = explicitPassword || (useResendDefaults ? resendApiKey : undefined);
  if (Boolean(user) !== Boolean(pass)) throw new EmailConfigurationError();

  const secure = booleanEnvironment("SMTP_SECURE", useResendDefaults);
  const requireTLS = booleanEnvironment("SMTP_REQUIRE_TLS", true);
  if (process.env.NODE_ENV === "production" && !secure && !requireTLS) {
    throw new EmailConfigurationError();
  }

  return {
    host,
    port,
    secure,
    requireTLS,
    from: required("SMTP_FROM"),
    ...(process.env.SMTP_REPLY_TO?.trim() ? { replyTo: process.env.SMTP_REPLY_TO.trim() } : {}),
    ...(user && pass ? { auth: { user, pass } } : {}),
  };
}

export function isEmailDeliveryConfigured(): boolean {
  try {
    smtpConfigFromEnvironment();
    return true;
  } catch (error) {
    if (error instanceof EmailConfigurationError) return false;
    throw error;
  }
}

export async function sendEmail(input: {
  to: string;
  subject: string;
  text: string;
}): Promise<void> {
  const config = smtpConfigFromEnvironment();
  const transporter: Transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: config.requireTLS,
    auth: config.auth,
    tls: { rejectUnauthorized: true },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  try {
    await transporter.sendMail({
      from: config.from,
      to: input.to,
      ...(config.replyTo ? { replyTo: config.replyTo } : {}),
      subject: input.subject,
      text: input.text,
    });
  } catch {
    throw new EmailDeliveryError();
  }
}
