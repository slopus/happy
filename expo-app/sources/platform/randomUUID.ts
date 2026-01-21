/**
 * Platform adapter: UUID v4.
 *
 * Strategy:
 * - App runtime (native + web): use `expo-crypto` (Expo provides a web implementation internally).
 * - Tests (vitest/node): alias `@/platform/randomUUID` to `randomUUID.node.ts`.
 */

import { randomUUID as expoRandomUUID } from 'expo-crypto';

export function randomUUID(): string {
    return expoRandomUUID();
}

