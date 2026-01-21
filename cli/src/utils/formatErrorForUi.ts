/**
 * Convert an unknown thrown value into a user-visible string.
 *
 * Intended for UI surfaces (TUI/mobile) where giant stacks can be noisy; we keep a generous cap.
 */
export function formatErrorForUi(error: unknown, opts?: { maxChars?: number }): string {
    const maxChars = Math.max(1000, opts?.maxChars ?? 50_000);
    const msg = error instanceof Error
        ? (error.stack || error.message || String(error))
        : String(error);

    return msg.length > maxChars ? `${msg.slice(0, maxChars)}\n…[truncated]` : msg;
}

