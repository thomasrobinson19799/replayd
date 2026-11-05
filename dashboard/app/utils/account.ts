export function passwordError(value: string): string {
  if ([...value].length < 10) return "Use at least 10 characters.";
  if (new TextEncoder().encode(value).length > 256)
    return "Use no more than 256 bytes.";
  return "";
}
export function safeReturnPath(value: unknown): string {
  return typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\")
    ? value
    : "/";
}
