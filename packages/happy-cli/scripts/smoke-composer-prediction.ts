/** Opt-in real Codex smoke: one root generation and one auxiliary sample, no Happy session writes. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServerClient } from '../src/codex/codexAppServerClient';
import { createComposerPredictionHandlers } from '../src/codex/composerPrediction';

const cwd = await mkdtemp(join(tmpdir(), 'paws-prediction-smoke-'));
const client = new CodexAppServerClient();
let completedTurnId: string | undefined;
let rootStarts = 0;
client.setEventHandler(event => {
    if (event.type === 'task_complete' && typeof event.turn_id === 'string') completedTurnId = event.turn_id;
    if (event.type === 'task_started') rootStarts++;
});
client.setApprovalHandler(async () => 'denied');
try {
    await client.connect();
    const thread = await client.startThread({ model: 'gpt-6.1-sol', cwd, approvalPolicy: 'never', sandbox: 'read-only' });
    await client.sendTurnAndWait('Write a one-sentence birthday greeting for my sister Mei, then ask whether I want a warmer version. Do not use tools.', { turnTimeoutMs: 60_000 });
    if (!completedTurnId) throw new Error('Root completion did not carry a stable turn id');
    const before = await client.readThread({ threadId: thread.threadId, includeTurns: true });
    const handlers = createComposerPredictionHandlers({ client, isBusy: () => false, onUnsupported() {} });
    const started = Date.now();
    const result = await handlers.request({ requestId: 'real-smoke', sourceTurnId: completedTurnId });
    const after = await client.readThread({ threadId: thread.threadId, includeTurns: true });
    if (JSON.stringify(before.thread.turns) !== JSON.stringify(after.thread.turns)) throw new Error('Sample changed root history');
    if (rootStarts !== 1) throw new Error('Sample surfaced as an extra root turn');
    console.log(JSON.stringify({ model: thread.model, elapsedMs: Date.now() - started, result,
        rootHistoryUnchanged: true, rootStarts }, null, 2));
    if (result.status !== 'ready') process.exitCode = 1;
} finally {
    await client.disconnect({ waitForExit: true });
    await rm(cwd, { recursive: true, force: true });
}
