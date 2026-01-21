/**
 * Platform adapter: cryptographically-secure random bytes.
 *
 * Strategy:
 * - App runtime (native + web): use `expo-crypto`.
 *   Expo implements a web-specific version internally (see `ExpoCrypto.web.ts` in Expo SDK),
 *   so we keep behavior consistent across Expo platforms without maintaining our own `.web` fork.
 * - Tests (vitest/node): alias `@/platform/cryptoRandom` to `cryptoRandom.node.ts`.
 *
 * IMPORTANT:
 * - Do NOT import `expo-crypto` from code that runs in node tests unless it’s behind a vitest alias.
 */

import { getRandomBytes as expoGetRandomBytes, getRandomBytesAsync as expoGetRandomBytesAsync } from 'expo-crypto';

export function getRandomBytes(length: number): Uint8Array {
    return expoGetRandomBytes(length);
}

export async function getRandomBytesAsync(length: number): Promise<Uint8Array> {
    // Prefer Expo's async API (when available) to preserve call-site behavior.
    return await expoGetRandomBytesAsync(length);
}

