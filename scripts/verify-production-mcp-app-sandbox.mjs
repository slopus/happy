import { pathToFileURL } from 'node:url';

function normalizeHttpsOrigin(raw, label) {
    if (!raw || raw.trim() !== raw || /[\s;'"\\?#]/u.test(raw)) throw new Error(`${label} must be an exact HTTPS origin`);
    let url;
    try { url = new URL(raw); } catch { throw new Error(`${label} must be an exact HTTPS origin`); }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/'
        || url.search || url.hash || !url.hostname || url.hostname.includes('*') || url.hostname.endsWith('.')) {
        throw new Error(`${label} must be an exact HTTPS origin`);
    }
    return url.origin;
}

function cspMetadata() {
    return Buffer.from(JSON.stringify({ connectDomains: [], resourceDomains: [], frameDomains: [] }), 'utf8').toString('base64url');
}

export function buildMcpAppSandboxVerificationUrls(sandboxOrigin, parentOrigin) {
    const csp = cspMetadata();
    const accepted = new URL('/mcp-app-sandbox/host', sandboxOrigin);
    accepted.searchParams.set('parentOrigin', parentOrigin);
    accepted.searchParams.set('csp', csp);
    const rejected = new URL(accepted);
    rejected.searchParams.set('parentOrigin', 'https://rejected-parent.invalid');
    return {
        acceptedHost: accepted.toString(),
        rejectedParent: rejected.toString(),
        unknownPath: new URL('/mcp-app-sandbox/not-a-route', sandboxOrigin).toString(),
        hostScript: new URL('/mcp-app-sandbox/host.js', sandboxOrigin).toString(),
    };
}

function assertStatus(label, response, expected) {
    if (response.status !== expected) throw new Error(`${label} returned HTTP ${response.status}; expected HTTP ${expected}`);
}

function assertNoStore(label, response) {
    const value = response.headers.get('cache-control') ?? '';
    if (!value.split(',').some((token) => token.trim().toLowerCase() === 'no-store')) {
        throw new Error(`${label} cache-control must include no-store`);
    }
}

function assertNoCors(label, response) {
    for (const name of response.headers.keys()) {
        if (name.toLowerCase().startsWith('access-control-')) throw new Error(`${label} exposed permissive CORS headers`);
    }
}

function assertExactHeader(label, response, name, expected) {
    const actual = response.headers.get(name) ?? '';
    if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error(`${label} ${name} must be ${expected}`);
}

function assertHtmlSecurity(response, parentOrigin) {
    const contentType = response.headers.get('content-type') ?? '';
    if (!/^text\/html\b/iu.test(contentType)) throw new Error('accepted host content-type must be HTML');
    const csp = response.headers.get('content-security-policy') ?? '';
    const directives = new Map();
    for (const raw of csp.split(';').map((directive) => directive.trim()).filter(Boolean)) {
        const [name, ...values] = raw.split(/\s+/u);
        if (directives.has(name)) throw new Error(`accepted host CSP duplicates ${name}`);
        directives.set(name, values.join(' '));
    }
    const expected = new Map([
        ['default-src', "'none'"], ['script-src', "'self' 'unsafe-inline'"], ['style-src', "'unsafe-inline'"],
        ['img-src', 'data: blob:'], ['media-src', 'blob:'], ['font-src', 'data:'], ['connect-src', "'none'"],
        ['frame-src', "'self'"], ['object-src', "'none'"], ['base-uri', "'none'"], ['form-action', "'none'"],
        ['frame-ancestors', parentOrigin],
    ]);
    if (directives.size !== expected.size) throw new Error('accepted host CSP has missing or extra directives');
    for (const [name, value] of expected) {
        if (directives.get(name) !== value) throw new Error(`accepted host CSP ${name} does not match the exact policy`);
    }
    const permissions = response.headers.get('permissions-policy') ?? '';
    const permissionParts = permissions.split(',').map((part) => part.trim()).filter(Boolean);
    const exactPermissions = ['camera=()', 'microphone=()', 'geolocation=()', 'clipboard-write=()'];
    if (permissionParts.length !== exactPermissions.length || new Set(permissionParts).size !== permissionParts.length
        || exactPermissions.some((directive) => !permissionParts.includes(directive))) {
        throw new Error('accepted host permissions-policy does not match the exact policy');
    }
    assertExactHeader('accepted host', response, 'x-content-type-options', 'nosniff');
    assertExactHeader('accepted host', response, 'referrer-policy', 'no-referrer');
    assertExactHeader('accepted host', response, 'cross-origin-resource-policy', 'cross-origin');
}

function assertScriptSecurity(response) {
    const contentType = response.headers.get('content-type') ?? '';
    if (!/^(?:text|application)\/javascript\b/iu.test(contentType)) throw new Error('host script content-type must be JavaScript');
    assertExactHeader('host script', response, 'x-content-type-options', 'nosniff');
    assertExactHeader('host script', response, 'cross-origin-resource-policy', 'same-origin');
}

async function fetchWithDeadline(fetchImpl, url, options, timeoutMs, overallSignal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    let rejectOverall;
    const overallRejection = new Promise((_resolve, reject) => { rejectOverall = reject; });
    const rejectOnOverall = () => {
        controller.abort();
        rejectOverall(new Error('MCP App sandbox verification timed out'));
    };
    overallSignal.addEventListener('abort', abort, { once: true });
    overallSignal.addEventListener('abort', rejectOnOverall, { once: true });
    let timer;
    try {
        return await Promise.race([
            fetchImpl(url, { ...options, signal: controller.signal }),
            new Promise((_resolve, reject) => {
                timer = setTimeout(() => { controller.abort(); reject(new Error('MCP App sandbox verification timed out')); }, timeoutMs);
            }),
            overallRejection,
        ]);
    } finally {
        clearTimeout(timer);
        overallSignal.removeEventListener('abort', abort);
        overallSignal.removeEventListener('abort', rejectOnOverall);
    }
}

export async function verifyProductionMcpAppSandbox({ sandboxOrigin: rawSandbox, parentOrigin: rawParent, fetchImpl = fetch, requestTimeoutMs = 5_000, overallTimeoutMs = 15_000 }) {
    const sandboxOrigin = normalizeHttpsOrigin(rawSandbox, 'Sandbox origin');
    const parentOrigin = normalizeHttpsOrigin(rawParent, 'Parent origin');
    if (sandboxOrigin === parentOrigin) throw new Error('Sandbox origin must use a different origin from the Paws parent origin');
    const urls = buildMcpAppSandboxVerificationUrls(sandboxOrigin, parentOrigin);
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0 || !Number.isFinite(overallTimeoutMs) || overallTimeoutMs <= 0) {
        throw new Error('Verification deadlines must be positive');
    }
    const overall = new AbortController();
    const overallTimer = setTimeout(() => overall.abort(), overallTimeoutMs);
    let responses;
    try {
        responses = await Promise.race([
            Promise.all(Object.values(urls).map((url) => fetchWithDeadline(fetchImpl, url, { redirect: 'error' }, requestTimeoutMs, overall.signal))),
            new Promise((_resolve, reject) => overall.signal.addEventListener('abort', () => reject(new Error('MCP App sandbox verification timed out')), { once: true })),
        ]);
    } finally {
        clearTimeout(overallTimer);
        overall.abort();
    }
    const [acceptedHost, rejectedParent, unknownPath, hostScript] = responses;
    assertStatus('accepted host', acceptedHost, 200);
    assertStatus('rejected parent', rejectedParent, 404);
    assertStatus('unknown sandbox path', unknownPath, 404);
    assertStatus('host script', hostScript, 200);
    for (const [label, response] of [
        ['accepted host', acceptedHost], ['rejected parent', rejectedParent],
        ['unknown sandbox path', unknownPath], ['host script', hostScript],
    ]) {
        assertNoStore(label, response);
        assertNoCors(label, response);
    }
    assertHtmlSecurity(acceptedHost, parentOrigin);
    assertScriptSecurity(hostScript);
    return { checks: 4 };
}

async function main() {
    const [sandboxOrigin, parentOrigin] = process.argv.slice(2);
    if (!sandboxOrigin || !parentOrigin) {
        throw new Error('Usage: node scripts/verify-production-mcp-app-sandbox.mjs <sandbox-origin> <paws-parent-origin>');
    }
    const result = await verifyProductionMcpAppSandbox({ sandboxOrigin, parentOrigin });
    process.stdout.write(`OK MCP App sandbox security contract (${result.checks} requests)\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main().catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : 'MCP App sandbox verification failed'}\n`);
        process.exitCode = 1;
    });
}
