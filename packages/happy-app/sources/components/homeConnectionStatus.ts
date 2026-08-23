export type HomeSocketStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * Home headers only need to call attention to a socket that is not healthy.
 * A custom subtitle owns the secondary line, so it continues to suppress the
 * connection status just as it did before the connected state was hidden.
 */
export function shouldShowHomeConnectionStatus(
    status: HomeSocketStatus,
    hasCustomSubtitle = false,
): boolean {
    return status !== 'connected' && !hasCustomSubtitle;
}