// Vitest runs in a Node environment; `expo-modules-core` is designed for Expo/Metro and
// imports `react-native` (Flow) via its TS source entrypoint. For unit tests we only need
// a minimal subset of the surface area used by other Expo packages (e.g. `expo-localization`).

export const Platform = {
    // Match the shape used by `expo-localization` on web/Node.
    isDOMAvailable: typeof window !== 'undefined' && typeof document !== 'undefined',
    OS: 'node',
    select: <T,>(specifics: Record<string, T> & { default?: T }) =>
        (specifics as any).node ?? (specifics as any).default,
} as const;

