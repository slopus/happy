// Module resolution for running happy-app's TypeScript sources under plain Node.
// Node strips the types; these hooks supply what Metro and Babel normally do:
// the `@/` alias, extensionless relative imports, the web flavour of native
// modules, and shims for expo-crypto and libsodium.

const APP_SOURCES = new URL('../../../happy-app/sources/', import.meta.url);
const TOOLS = new URL('./', import.meta.url);

const REDIRECTS = {
    'expo-crypto': new URL('./shims/expo-crypto.mjs', import.meta.url).href,
    '@/encryption/libsodium.lib': new URL('./shims/libsodium.lib.mjs', import.meta.url).href,
    // The web implementation of the AES module (crypto.subtle); the native one is rn-encryption.
    '@/encryption/aes': new URL('encryption/aes.web.ts', APP_SOURCES).href,
};

function typescript(url) {
    return { url, format: 'module-typescript', shortCircuit: true };
}

export async function resolve(specifier, context, nextResolve) {
    if (REDIRECTS[specifier]) {
        const url = REDIRECTS[specifier];
        return url.endsWith('.ts') ? typescript(url) : { url, shortCircuit: true };
    }
    if (specifier.startsWith('@/')) {
        return typescript(new URL(specifier.slice(2) + '.ts', APP_SOURCES).href);
    }
    const parent = context.parentURL ?? '';
    if (parent.endsWith('.ts') && (specifier.startsWith('./') || specifier.startsWith('../'))) {
        const url = new URL(specifier, parent).href;
        return typescript(url.endsWith('.ts') ? url : url + '.ts');
    }
    if (parent.startsWith(APP_SOURCES.href)) {
        // happy-app's own node_modules are not installed here; use ours.
        return nextResolve(specifier, { ...context, parentURL: TOOLS.href });
    }
    return nextResolve(specifier, context);
}
