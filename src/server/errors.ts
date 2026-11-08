/**
 * Errors with a stable code the UI can translate (messages: errors.<code>).
 * Stored on failed tasks as "[code] message".
 */
export class UserFacingError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "UserFacingError";
  }
}

export function errorCodeOf(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return null;
}

export function formatTaskError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCodeOf(error);
  return code ? `[${code}] ${message}` : message;
}

export function parseTaskError(error: string | null): { code: string | null; message: string | null } {
  if (!error) return { code: null, message: null };
  const m = /^\[([\w-]+)\]\s*(.*)$/s.exec(error);
  return m ? { code: m[1], message: m[2] } : { code: null, message: error };
}
