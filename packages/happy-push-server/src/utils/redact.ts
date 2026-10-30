/** Last few characters of a native token, for logs. Never log the whole token. */
export function redactToken(token: string): string {
    return token.length <= 8 ? '…' : `…${token.slice(-6)}`;
}
