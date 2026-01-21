// Vitest/node stub for `react-native`.
// This avoids Vite trying to parse the real React Native entrypoint (Flow syntax).

export const Platform = { OS: 'node', select: (x: any) => x?.default } as const;
export const AppState = { addEventListener: () => ({ remove: () => {} }) } as const;
export const InteractionManager = { runAfterInteractions: (fn: () => void) => fn() } as const;

