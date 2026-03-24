const DEBUG_TRUE_VALUES = new Set(['1', 'true']);

/**
 * Check if DEBUG mode is explicitly enabled.
 * Only recognizes DEBUG=1 or DEBUG=true, ignoring ambient values
 * like DEBUG=release injected by hosting platforms (e.g. Coder).
 */
export function isDebug(): boolean {
    return DEBUG_TRUE_VALUES.has(process.env.DEBUG?.toLowerCase() ?? '');
}
