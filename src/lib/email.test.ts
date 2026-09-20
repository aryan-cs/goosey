import { afterEach, describe, expect, it, vi } from "vitest";

import { isEmailDeliveryConfigured, smtpConfigFromEnvironment } from "./email";

describe("email provider configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses the Vercel Resend integration key without copying it into SMTP_PASSWORD", () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_provider_key");
    vi.stubEnv("SMTP_HOST", "");
    vi.stubEnv("SMTP_PORT", "");
    vi.stubEnv("SMTP_SECURE", "");
    vi.stubEnv("SMTP_USER", "");
    vi.stubEnv("SMTP_PASSWORD", "");
    vi.stubEnv("SMTP_FROM", "Goosey <verify@goosey.example>");

    expect(smtpConfigFromEnvironment()).toMatchObject({
      host: "smtp.resend.com",
      port: 465,
      secure: true,
      requireTLS: true,
      auth: { user: "resend", pass: "re_test_provider_key" },
    });
    expect(isEmailDeliveryConfigured()).toBe(true);
  });

  it("still requires a verified sender address with a Resend key", () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_provider_key");
    vi.stubEnv("SMTP_FROM", "");

    expect(isEmailDeliveryConfigured()).toBe(false);
  });

  it("does not apply Resend credentials to an explicitly different SMTP service", () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_provider_key");
    vi.stubEnv("SMTP_HOST", "smtp.example.com");
    vi.stubEnv("SMTP_PORT", "587");
    vi.stubEnv("SMTP_FROM", "Goosey <verify@example.com>");
    vi.stubEnv("SMTP_USER", "");
    vi.stubEnv("SMTP_PASSWORD", "");

    const config = smtpConfigFromEnvironment();
    expect(config).toMatchObject({
      host: "smtp.example.com",
      port: 587,
    });
    expect(config).not.toHaveProperty("auth");
  });
});
