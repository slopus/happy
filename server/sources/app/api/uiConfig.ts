export type UiConfig = {
    dir: string | null;
    /**
     * UI mount prefix for route registration (no trailing slash).
     * - "/" means "mounted at root"
     * - "/ui" means "mounted under /ui"
     */
    prefix: string;
    mountRoot: boolean;
};

export function resolveUiConfig(env: NodeJS.ProcessEnv = process.env): UiConfig {
    const dirRaw = env.HAPPY_SERVER_UI_DIR ?? env.HAPPY_SERVER_LIGHT_UI_DIR;
    const dir = typeof dirRaw === 'string' && dirRaw.trim() ? dirRaw.trim() : null;

    const prefixRaw = env.HAPPY_SERVER_UI_PREFIX ?? env.HAPPY_SERVER_LIGHT_UI_PREFIX;
    const prefixNormalized = typeof prefixRaw === 'string' && prefixRaw.trim() ? prefixRaw.trim() : '/';
    const mountRoot = prefixNormalized === '/' || prefixNormalized === '';
    const prefix = mountRoot
        ? '/'
        : prefixNormalized.endsWith('/')
            ? prefixNormalized.slice(0, -1)
            : prefixNormalized;

    return { dir, prefix, mountRoot };
}
