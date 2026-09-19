/** Use name parts, not the first characters of the full name. */
export function initials(name: string): string {
  const parts = name.normalize("NFC").match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'’]*/gu) ?? [];
  const letters = parts.slice(0, 3).map(part => Array.from(part)[0]).join("").toUpperCase();
  return Array.from(letters).slice(0, 3).join("") || "?";
}
