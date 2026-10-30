/**
 * Public push tokens look like `HappyPushToken[<22 base62 chars>]` (~131 bits
 * of randomness), mirroring Expo's `ExponentPushToken[...]`. The id is the
 * only thing a sender needs, so it must be unguessable; it is minted once per
 * (appId, deviceId) and never changes.
 */

const PREFIX = 'HappyPushToken[';
const SUFFIX = ']';
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ID_LENGTH = 22;
const TOKEN_PATTERN = /^HappyPushToken\[([0-9A-Za-z]{22})\]$/;

export function mintDeviceId(): string {
    let id = '';
    while (id.length < ID_LENGTH) {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        for (const byte of bytes) {
            // 248 = 62 * 4: rejecting the top values keeps every char uniform.
            if (byte < 248 && id.length < ID_LENGTH) {
                id += ALPHABET[byte % 62];
            }
        }
    }
    return id;
}

export function formatPushToken(id: string): string {
    return PREFIX + id + SUFFIX;
}

/** Returns the device id inside a `HappyPushToken[...]`, or null if it is not one. */
export function parsePushToken(token: string): string | null {
    return TOKEN_PATTERN.exec(token)?.[1] ?? null;
}
