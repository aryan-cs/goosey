export function prismaErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" && /^P\d{4}$/.test(error.code) ? error.code : null;
}

export function isPrismaErrorCode(error: unknown, ...codes: string[]): boolean {
  const code = prismaErrorCode(error);
  return code !== null && codes.includes(code);
}
