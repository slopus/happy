// Preloaded into the TS server by tsserver.sh (`node --import`): sends requests for
// the hard-coded third-party endpoints to the harness mock instead, as
// `$COMPAT_MOCK/<host><path>`. The Rust server gets the same URLs through its
// HAPPY_RS_* overrides (rsserver.sh).
const MOCK = process.env.COMPAT_MOCK;
const HOSTS = new Set(['exp.host', 'api.elevenlabs.io', 'github.com', 'api.github.com']);
const real = globalThis.fetch;
globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(url);
    if (MOCK && u.protocol === 'https:' && HOSTS.has(u.host)) {
        return real(`${MOCK}/${u.host}${u.pathname}${u.search}`, init);
    }
    return real(input, init);
};
