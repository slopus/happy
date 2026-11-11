// The remote debug log route (DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING).
const L = '/logs-combined-from-cli-and-mobile-for-simple-ai-debugging';

export async function scenario(t) {
    const ok = { timestamp: '2026-01-01T00:00:00Z', level: 'info', message: 'hello', source: 'cli' };
    await t.req('devlog empty', 'POST', L, { body: {} });
    await t.req('devlog bad source', 'POST', L, { body: { ...ok, source: 'web' } });
    await t.req('devlog number message', 'POST', L, { body: { ...ok, message: 1 } });
    for (const level of ['info', 'ERROR', 'warning', 'warn', 'debug', 'trace', '']) {
        await t.req(`devlog level ${JSON.stringify(level)}`, 'POST', L, { body: { ...ok, level, platform: 'ios', messageRawObject: { a: 1 } } });
    }
    await t.req('devlog extra keys', 'POST', L, { body: { ...ok, extra: true } });
    await t.req('devlog GET', 'GET', L);
}
