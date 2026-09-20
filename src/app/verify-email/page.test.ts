import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connection: vi.fn(),
  emailVerificationEnabled: vi.fn(),
  redirect: vi.fn((destination: string) => {
    throw new Error(`redirect:${destination}`);
  }),
}));

vi.mock("next/server", () => ({ connection: mocks.connection }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/auth", () => ({ emailVerificationEnabled: mocks.emailVerificationEnabled }));
vi.mock("@/components/email-verification-flow", () => ({ EmailVerificationFlow: () => null }));

import VerifyEmailPage from "./page";

describe("verify email page", () => {
  beforeEach(() => vi.clearAllMocks());

  it("redirects direct visits when verified email delivery is unavailable", async () => {
    mocks.emailVerificationEnabled.mockReturnValue(false);

    await expect(VerifyEmailPage()).rejects.toThrow("redirect:/");
    expect(mocks.connection).toHaveBeenCalledOnce();
    expect(mocks.redirect).toHaveBeenCalledWith("/");
  });

  it("renders the verification flow when delivery is configured and enabled", async () => {
    mocks.emailVerificationEnabled.mockReturnValue(true);

    await expect(VerifyEmailPage()).resolves.toMatchObject({
      props: { className: "auth-page" },
    });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
