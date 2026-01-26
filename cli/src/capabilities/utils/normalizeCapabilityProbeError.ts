export function normalizeCapabilityProbeError(error: unknown): { message: string } {
    if (error && typeof error === 'object') {
        const maybeMessage = (error as { message?: unknown }).message;
        if (typeof maybeMessage === 'string' && maybeMessage.length > 0) {
            return { message: maybeMessage };
        }
    }
    if (typeof error === 'string' && error.length > 0) {
        return { message: error };
    }
    return { message: String(error) };
}
