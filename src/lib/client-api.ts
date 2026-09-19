export interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
  message?: string;
}

export const EMAIL_VERIFICATION_REQUIRED_EVENT = "goosey:email-verification-required";

export function isEmailVerificationRequired(status: number, body: ApiErrorBody | null) {
  return status === 403 && body?.error?.code === "EMAIL_VERIFICATION_REQUIRED";
}

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status !== 403 || typeof window === "undefined") return response;
  const body = await response.clone().json().catch(() => null) as ApiErrorBody | null;
  if (isEmailVerificationRequired(response.status, body)) {
    window.dispatchEvent(new CustomEvent(EMAIL_VERIFICATION_REQUIRED_EVENT, { detail: body?.error?.details }));
  }
  return response;
}
