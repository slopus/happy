export type AppMode = 'happy' | 'learn';

export const APP_MODE: AppMode =
    (process.env.EXPO_PUBLIC_APP_MODE as AppMode) || 'happy';

export const isLearnMode = APP_MODE === 'learn';
export const isHappyMode = APP_MODE === 'happy';
