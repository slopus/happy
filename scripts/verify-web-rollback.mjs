const [origin] = process.argv.slice(2);

if (!origin) throw new Error('Usage: node scripts/verify-web-rollback.mjs <origin>');

function positiveDuration(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
    return value;
}

const normalizedOrigin = origin.replace(/\/+$/, '');
const timeoutMs = positiveDuration('PAWS_WEB_ROLLBACK_TIMEOUT_MS', 30_000);
const retryIntervalMs = positiveDuration('PAWS_WEB_ROLLBACK_RETRY_INTERVAL_MS', 1_000);
const deadline = Date.now() + timeoutMs;
let lastError;

async function fetchWithinDeadline(pathname) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const response = await fetch(`${normalizedOrigin}${pathname}`, {
        redirect: 'follow',
        signal: AbortSignal.timeout(remainingMs),
    });
    if (!response.ok) throw new Error(`${pathname} returned HTTP ${response.status}`);
    await response.body?.cancel();
}

do {
    try {
        await fetchWithinDeadline('/');
        await fetchWithinDeadline('/health');
        console.log('OK rollback data plane is reachable');
        process.exit(0);
    } catch (error) {
        lastError = error;
        if (Date.now() >= deadline) break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(retryIntervalMs, deadline - Date.now())));
    }
} while (Date.now() <= deadline);

throw new Error(`rollback data plane did not become reachable within ${timeoutMs}ms: ${lastError?.message ?? 'unknown error'}`, {
    cause: lastError,
});
