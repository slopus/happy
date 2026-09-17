import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FollowUpSnapshot, ImageRef, RunSnapshot, StartInput } from '../src/contracts.js';
import { createPocServer, type PocServer } from '../src/server/http.js';
import { decryptText } from '../vendor/agents-party/src/core/crypto.js';
import type { Message as PartyMessage } from '../vendor/agents-party/src/core/types.js';
import { TestOnlySdk } from './fake-sdk.js';

const token = 'runs-test-token';
const dirs: string[] = [];
const servers: PocServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function start(sdk: TestOnlySdk, turnTimeoutMs?: number): Promise<PocServer> {
  const dataDir = await mkdtemp(join(tmpdir(), 'paws-agent-party-runs-'));
  dirs.push(dataDir);
  return startAt(sdk, dataDir, turnTimeoutMs);
}

async function startAt(sdk: TestOnlySdk, dataDir: string, turnTimeoutMs?: number): Promise<PocServer> {
  const server = await createPocServer({ dataDir, accessToken: token, sdk: sdk as never, turnTimeoutMs });
  servers.push(server);
  return server;
}

const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

describe('consultation runs', () => {
  it('persists exact task/result and SDK turn provenance across roles, turns and restart', async () => {
    const sdk = new TestOnlySdk();
    const server = await start(sdk);
    const started = await postStart(server, input());
    const completed = await waitForTerminal(server, started.id);
    const turns = completed.turns;
    expect(turns).toHaveLength(8);
    const publicMessages = await readParty(server, completed.partyId);
    for (const turn of turns) {
      expect(turn.runId).toBe(completed.id);
      expect(turn.partyId).toBe(completed.partyId);
      expect(turn.sessionId).toBe(`session-${turn.participant}`);
      const task = publicMessages.find(message => message.id === turn.taskMessageId);
      const result = publicMessages.find(message => message.id === turn.publicMessageId);
      expect(task?.from).toBe('host');
      expect(result?.from).toBe(turn.participant);
      expect(result?.replyTo).toBe(turn.taskMessageId);
      const page = await sdk.historyPage(turn.sessionId!, { afterSeq: 0, limit: 200 });
      expect(page.messages.some(message => message.localId === turn.localId)).toBe(true);
      expect(page.messages.find(message => message.id === turn.sourceMessageId)?.content).toMatchObject({
        role: 'session', content: { role: 'agent', turn: turn.rootTurnId, ev: { t: 'turn-end', status: 'completed' } },
      });
    }
    expect(turns.filter(turn => turn.participant === 'trend30').map(turn => turn.rootTurnId)).toEqual(['root-1', 'root-2']);
    const dataDir = dirs.at(-1)!;
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    const restarted = await startAt(sdk, dataDir);
    const restored = await fetch(`${restarted.url}/api/consultations/${started.id}`, { headers }).then(response => response.json());
    expect(restored.turns).toEqual(turns);
    expect(sdk.calls).toHaveLength(8);
  });
  it('rejects a remote run before the Paws account is linked', async () => {
    const server = await start(new TestOnlySdk({ ready: false }));

    const response = await fetch(`${server.url}/api/consultations`, {
      method: 'POST', headers, body: JSON.stringify(input()),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Link a Paws account before starting a consultation.' });
  });

  it('deduplicates requestId, runs exactly eight turns, forwards images, and publishes only statements', async () => {
    const sdk = new TestOnlySdk();
    const server = await start(sdk);
    const image = await upload(server, new Uint8Array([9, 8, 7]));
    const body = input({ images: [image] });

    const [first, replay] = await Promise.all([postStart(server, body), postStart(server, body)]);
    expect(replay.id).toBe(first.id);
    const completed = await waitForTerminal(server, first.id);

    expect(completed.status).toBe('completed');
    expect(sdk.callsFor('trend30')).toHaveLength(2);
    expect(sdk.callsFor('structure10')).toHaveLength(2);
    expect(sdk.callsFor('timing1')).toHaveLength(2);
    expect(sdk.callsFor('moderator')).toHaveLength(2);
    expect(sdk.calls).toHaveLength(8);
    expect(sdk.calls.map(call => call.role)).toEqual([
      'moderator',
      'trend30', 'structure10', 'timing1',
      'trend30', 'structure10', 'timing1',
      'moderator',
    ]);
    expect(sdk.callsFor('moderator')[0].text).toContain('30-minute:');
    expect(sdk.callsFor('moderator')[0].text).toContain('10-minute:');
    expect(sdk.callsFor('moderator')[0].text).toContain('1-minute:');
    expect(sdk.callsFor('trend30')[0].text).toContain('30-minute trend');
    expect(sdk.callsFor('structure10')[0].text).toContain('10-minute structure');
    expect(sdk.callsFor('timing1')[0].text).toContain('1-minute timing');
    expect(sdk.calls.every(call => call.text.includes('not investment advice'))).toBe(true);
    expect(sdk.calls.every(call => call.text.includes('Do not fetch real-time market data'))).toBe(true);
    expect(sdk.calls.every(call => call.text.includes('Do not place orders or modify project files'))).toBe(true);
    expect(sdk.calls.every(call => call.images?.[0]?.bytes.byteLength === 3)).toBe(true);
    const publicMessages = await readParty(server, completed.partyId);
    expect(publicMessages.some(message => message.text.includes('tool-secret'))).toBe(false);
    expect(publicMessages.filter(message => message.from !== 'host').map(message => message.text)).toContain('public-moderator-2');
  });

  it('marks a failed agent run failed and does not execute dependent moderator rounds', async () => {
    const sdk = new TestOnlySdk({ failRole: 'timing1' });
    const server = await start(sdk);
    const started = await postStart(server, input());

    const failed = await waitForTerminal(server, started.id);

    expect(failed.status).toBe('failed');
    expect(sdk.callsFor('moderator')).toHaveLength(1);
  });

  it('stop aborts coordination and unsubscribes without claiming remote process termination', async () => {
    const sdk = new TestOnlySdk({ delayMs: 2_000 });
    const server = await start(sdk);
    const started = await postStart(server, input());
    await waitUntil(() => sdk.calls.length > 0);

    const response = await fetch(`${server.url}/api/consultations/${started.id}/stop`, {
      method: 'POST', headers, body: '{}',
    });
    const stopped = await response.json() as RunSnapshot;

    expect(response.status).toBe(200);
    expect(stopped.status).toBe('stopped');
    expect((await fetch(`${server.url}/api/paws/link`, { method: 'DELETE', headers })).status).toBe(200);
    await waitUntil(() => sdk.unsubscribeCount > 0);
    expect(sdk.sessionsStopped).toBe(0);
  });

  it('serializes terminal follow-ups per role and exposes durable owner-only agent history', async () => {
    const sdk = new TestOnlySdk({ delayMs: 20 });
    const server = await start(sdk);
    const started = await postStart(server, input());
    await waitForTerminal(server, started.id);

    const follow = (requestId: string) => fetch(`${server.url}/api/consultations/${started.id}/messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ requestId, text: `Follow ${requestId}`, to: ['trend30'], images: [] }),
    });
    const [first, second] = await Promise.all([follow('follow-1'), follow('follow-2')]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toEqual({ accepted: true });
    await waitUntil(() => sdk.callsFor('trend30').length === 4);
    expect(sdk.maxConcurrentByRole.get('trend30')).toBe(1);

    const [duplicateA, duplicateB] = await Promise.all([follow('same-follow'), follow('same-follow')]);
    expect(duplicateA.status).toBe(200);
    expect(duplicateB.status).toBe(200);
    await waitUntil(() => sdk.callsFor('trend30').length >= 5);
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(sdk.callsFor('trend30')).toHaveLength(5);

    const details = await fetch(`${server.url}/api/consultations/${started.id}/agents/trend30/messages?afterSeq=0`, { headers });
    const body = await details.json() as { sessionId: string; messages: Array<{ seq: number }>; requests: unknown[] };
    expect(body.sessionId).toBe('session-trend30');
    expect(body.messages.length).toBeGreaterThan(0);
    expect(body.messages.map(message => message.seq)).toEqual([...body.messages.map(message => message.seq)].sort((a, b) => a - b));
    expect(body.requests).toEqual([]);
  });

  it('publishes the current follow-up images to Party and delivers the same images to Paws', async () => {
    const sdk = new TestOnlySdk();
    const server = await start(sdk);
    const initialImage = await upload(server, new Uint8Array([1]));
    const followUpImage = await upload(server, new Uint8Array([2]));
    const started = await postStart(server, input({ mode: 'single', images: [initialImage] }));
    await waitForTerminal(server, started.id);

    const response = await fetch(`${server.url}/api/consultations/${started.id}/messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ requestId: 'image-follow-up', text: '', to: [], images: [followUpImage] }),
    });
    expect(response.status).toBe(200);
    await waitUntil(() => sdk.callsFor('moderator').length === 2);

    const partyMessages = await readParty(server, started.partyId);
    const followUpTask = partyMessages.filter(message => message.from === 'host').at(-1);
    expect(followUpTask?.images).toEqual([followUpImage]);
    expect(sdk.callsFor('moderator').at(-1)?.images?.map(image => [...image.bytes])).toEqual([[2]]);
  });

  it('marks a persisted running consultation interrupted after restart without replaying it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'paws-agent-party-restart-'));
    dirs.push(dataDir);
    const firstSdk = new TestOnlySdk({ delayMs: 2_000 });
    const first = await startAt(firstSdk, dataDir);
    const started = await postStart(first, input());
    await waitUntil(() => firstSdk.calls.length > 0);
    await first.close();
    servers.splice(servers.indexOf(first), 1);

    const secondSdk = new TestOnlySdk();
    const second = await startAt(secondSdk, dataDir);
    const response = await fetch(`${second.url}/api/consultations/${started.id}`, { headers });
    const restored = await response.json() as RunSnapshot;

    expect(restored.status).toBe('interrupted');
    expect(secondSdk.calls).toHaveLength(0);
  });

  it('times out observation, removes the durable subscription, and fails the run', async () => {
    const deadlineMs = 60_123;
    const setRealTimeout = globalThis.setTimeout;
    let expireDeadline: (() => void) | undefined;
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      const handle = setRealTimeout(callback, delay, ...args);
      if (delay === deadlineMs) expireDeadline = () => { clearTimeout(handle); callback(...args); };
      return handle;
    });
    const delivery = deferred<void>();
    const sdk = new TestOnlySdk(); sdk.holdNextDelivery(delivery.promise);
    try {
      const server = await start(sdk, deadlineMs);
      const started = await postStart(server, input({ mode: 'single' }));
      // send happens only after watch resolves and the subscription is retained.
      // Trigger the production timer's callback at that boundary, rather than
      // racing filesystem/spawn latency against an arbitrary 30ms deadline.
      await waitUntil(() => sdk.calls.length === 1);
      expect(expireDeadline).toBeTypeOf('function');
      expect(sdk.unsubscribeCount).toBe(0);
      expireDeadline!();
      const failed = await waitForTerminal(server, started.id);
      expect(failed.status).toBe('failed');
      expect(failed.error).toContain('deadline');
      expect(sdk.unsubscribeCount).toBe(1);
    } finally { delivery.resolve(); timer.mockRestore(); }
  });

  it('rejects malformed attachment arrays at both start and follow-up boundaries', async () => {
    const sdk = new TestOnlySdk();
    const server = await start(sdk);
    const malformedStart = await fetch(`${server.url}/api/consultations`, {
      method: 'POST', headers, body: JSON.stringify({ ...input(), images: 'x' }),
    });
    expect(malformedStart.status).toBe(400);

    const started = await postStart(server, input({ mode: 'single', requestId: 'valid-run' }));
    await waitForTerminal(server, started.id);
    const malformedFollowUp = await fetch(`${server.url}/api/consultations/${started.id}/messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ requestId: 'bad-follow', text: 'hello', to: [], images: 'x' }),
    });
    expect(malformedFollowUp.status).toBe(400);
  });

  it('preserves a session link when a spawn resolves after coordination was stopped', async () => {
    const sdk = new TestOnlySdk({ spawnDelayMs: 80 });
    const server = await start(sdk);
    const started = await postStart(server, input({ mode: 'single', requestId: 'late-spawn' }));
    await waitUntil(async () => {
      const response = await fetch(`${server.url}/api/consultations/${started.id}`, { headers });
      return ((await response.json()) as RunSnapshot).roles.moderator.status === 'spawning';
    });
    await fetch(`${server.url}/api/consultations/${started.id}/stop`, { method: 'POST', headers, body: '{}' });

    let snapshot!: RunSnapshot;
    await waitUntil(async () => {
      const response = await fetch(`${server.url}/api/consultations/${started.id}`, { headers });
      snapshot = await response.json() as RunSnapshot;
      return snapshot.roles.moderator.sessionId === 'session-moderator';
    });

    expect(snapshot.status).toBe('stopped');
    expect(sdk.calls).toHaveLength(0);
  });

  it('does not let a spawn callback persist after close releases store ownership', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'paws-agent-party-late-close-'));
    dirs.push(dataDir);
    const spawnGate = deferred<void>();
    const firstSdk = new TestOnlySdk({ spawnGate: spawnGate.promise });
    const first = await startAt(firstSdk, dataDir);
    const started = await postStart(first, input({ mode: 'single', requestId: 'close-during-spawn' }));
    await waitUntil(() => firstSdk.spawnCalls === 1);

    await first.close();
    servers.splice(servers.indexOf(first), 1);
    const second = await startAt(new TestOnlySdk(), dataDir);
    expect((await getRun(second, started.id)).status).toBe('interrupted');

    spawnGate.resolve();
    await waitUntil(() => firstSdk.spawnResolved === 1);
    await new Promise(resolve => setImmediate(resolve));
    const persisted = JSON.parse(await readFile(join(dataDir, 'runs.json'), 'utf8')) as { runs: Array<{ snapshot: RunSnapshot }> };
    const stored = persisted.runs.find(run => run.snapshot.id === started.id)?.snapshot;
    expect(stored?.status).toBe('interrupted');
    expect(stored?.roles.moderator.sessionId).toBeUndefined();
  });

  it('reuses a stopped run pending spawn when a follow-up starts before it resolves', async () => {
    const spawnGate = deferred<void>();
    const sdk = new TestOnlySdk({ spawnGate: spawnGate.promise });
    const server = await start(sdk);
    const started = await postStart(server, input({ mode: 'single', requestId: 'reuse-pending-spawn' }));
    await waitUntil(() => sdk.spawnCalls === 1);
    await fetch(`${server.url}/api/consultations/${started.id}/stop`, { method: 'POST', headers, body: '{}' });

    const accepted = await postFollowUp(server, started.id, {
      requestId: 'while-spawn-pending', text: 'Continue after stop.', to: [], images: [],
    });
    expect(accepted.status).toBe(200);
    await waitUntil(async () => (await getRun(server, started.id)).roles.moderator.status === 'spawning');
    await new Promise(resolve => setImmediate(resolve));
    expect(sdk.spawnCalls).toBe(1);
    spawnGate.resolve();
    await waitUntil(() => sdk.callsFor('moderator').length === 1);

    expect(sdk.spawnCalls).toBe(1);
  });

  it('stops active and queued follow-ups and blocks unlinking until coordination is stopped', async () => {
    const sdk = new TestOnlySdk();
    const server = await start(sdk);
    const started = await postStart(server, input({ mode: 'single', requestId: 'follow-up-stop' }));
    await waitForTerminal(server, started.id);
    const deliveryGate = deferred<void>();
    sdk.holdNextDelivery(deliveryGate.promise);
    await postFollowUp(server, started.id, { requestId: 'active-follow', text: 'First', to: [], images: [] });
    await postFollowUp(server, started.id, { requestId: 'queued-follow', text: 'Second', to: [], images: [] });
    await waitUntil(() => sdk.callsFor('moderator').length === 2);

    const blockedUnlink = await fetch(`${server.url}/api/paws/link`, { method: 'DELETE', headers });
    expect(blockedUnlink.status).toBe(409);
    const stoppedResponse = await fetch(`${server.url}/api/consultations/${started.id}/stop`, {
      method: 'POST', headers, body: '{}',
    });
    const stopped = await stoppedResponse.json() as RunWithFollowUps;
    deliveryGate.resolve();
    await new Promise(resolve => setImmediate(resolve));

    expect(followUp(stopped, 'active-follow').status).toBe('stopped');
    expect(followUp(stopped, 'queued-follow').status).toBe('stopped');
    expect(sdk.callsFor('moderator')).toHaveLength(2);
    expect((await fetch(`${server.url}/api/paws/link`, { method: 'DELETE', headers })).status).toBe(200);
  });

  it('keeps a mixed failed/running follow-up active until stop terminates the surviving role', async () => {
    const sdk = new TestOnlySdk({ failRole: 'trend30' });
    const server = await start(sdk);
    const started = await postStart(server, input({ mode: 'single', requestId: 'mixed-running' }));
    await waitForTerminal(server, started.id);
    const deliveryGate = deferred<void>();
    sdk.holdNextDeliveryFor('structure10', deliveryGate.promise);
    await postFollowUp(server, started.id, {
      requestId: 'mixed-follow', text: 'Compare.', to: ['trend30', 'structure10'], images: [],
    });
    let active!: RunSnapshot;
    await waitUntil(async () => {
      active = await getRun(server, started.id);
      const follow = followUp(active, 'mixed-follow');
      return follow.roles.trend30?.status === 'failed' && follow.roles.structure10?.status === 'running';
    });

    expect(followUp(active, 'mixed-follow').status).toBe('running');
    expect((await fetch(`${server.url}/api/paws/link`, { method: 'DELETE', headers })).status).toBe(409);
    const stoppedResponse = await fetch(`${server.url}/api/consultations/${started.id}/stop`, {
      method: 'POST', headers, body: '{}',
    });
    const stopped = await stoppedResponse.json() as RunSnapshot;

    expect(followUp(stopped, 'mixed-follow').status).toBe('failed');
    expect(followUp(stopped, 'mixed-follow').roles.structure10?.status).toBe('stopped');
    expect((await fetch(`${server.url}/api/paws/link`, { method: 'DELETE', headers })).status).toBe(200);
    deliveryGate.resolve();
  });

  it('keeps a mixed failed/queued follow-up active behind earlier same-role work', async () => {
    const sdk = new TestOnlySdk({ failRole: 'trend30' });
    const server = await start(sdk);
    const started = await postStart(server, input({ mode: 'single', requestId: 'mixed-queued' }));
    await waitForTerminal(server, started.id);
    const deliveryGate = deferred<void>();
    sdk.holdNextDeliveryFor('structure10', deliveryGate.promise);
    await postFollowUp(server, started.id, {
      requestId: 'structure-blocker', text: 'Hold structure.', to: ['structure10'], images: [],
    });
    await waitUntil(() => sdk.callsFor('structure10').length === 1);
    await postFollowUp(server, started.id, {
      requestId: 'mixed-queued-follow', text: 'Compare later.', to: ['trend30', 'structure10'], images: [],
    });
    let active!: RunSnapshot;
    await waitUntil(async () => {
      active = await getRun(server, started.id);
      return followUp(active, 'mixed-queued-follow').roles.trend30?.status === 'failed';
    });

    expect(followUp(active, 'mixed-queued-follow').roles.structure10?.status).toBe('queued');
    expect(followUp(active, 'mixed-queued-follow').status).toBe('queued');
    await fetch(`${server.url}/api/consultations/${started.id}/stop`, { method: 'POST', headers, body: '{}' });
    deliveryGate.resolve();
  });

  it('interrupts queued roles on restart even when another recipient already failed', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'paws-agent-party-mixed-restart-'));
    dirs.push(dataDir);
    const first = await startAt(new TestOnlySdk(), dataDir);
    const started = await postStart(first, input({ mode: 'single', requestId: 'mixed-restart' }));
    await waitForTerminal(first, started.id);
    await first.close();
    servers.splice(servers.indexOf(first), 1);
    const path = join(dataDir, 'runs.json');
    const persisted = JSON.parse(await readFile(path, 'utf8')) as {
      runs: Array<{ snapshot: RunSnapshot }>;
      followupIds?: string[];
    };
    const stored = persisted.runs.find(run => run.snapshot.id === started.id)?.snapshot;
    if (!stored) throw new Error('Persisted run unavailable');
    stored.roles.structure10.status = 'spawning';
    stored.followUps.push({
      requestId: 'mixed-persisted',
      to: ['trend30', 'structure10'],
      status: 'failed',
      roles: {
        trend30: { status: 'failed', error: 'Remote trend30 turn failed.' },
        structure10: { status: 'queued' },
      },
      createdAt: 1,
      error: 'Remote trend30 turn failed.',
    });
    persisted.followupIds = [...(persisted.followupIds ?? []), `${started.id}:mixed-persisted`];
    await writeFile(path, JSON.stringify(persisted));

    const secondSdk = new TestOnlySdk();
    const second = await startAt(secondSdk, dataDir);
    const restored = await getRun(second, started.id);

    expect(followUp(restored, 'mixed-persisted').status).toBe('failed');
    expect(followUp(restored, 'mixed-persisted').roles.structure10?.status).toBe('interrupted');
    expect(restored.roles.structure10.status).toBe('interrupted');
    expect(secondSdk.calls).toHaveLength(0);
  });

  it('marks an active follow-up interrupted on restart without replaying it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'paws-agent-party-follow-restart-'));
    dirs.push(dataDir);
    const firstSdk = new TestOnlySdk();
    const first = await startAt(firstSdk, dataDir);
    const started = await postStart(first, input({ mode: 'single', requestId: 'follow-restart' }));
    await waitForTerminal(first, started.id);
    const deliveryGate = deferred<void>();
    firstSdk.holdNextDelivery(deliveryGate.promise);
    await postFollowUp(first, started.id, { requestId: 'interrupted-follow', text: 'Wait', to: [], images: [] });
    await waitUntil(() => firstSdk.callsFor('moderator').length === 2);

    await first.close();
    servers.splice(servers.indexOf(first), 1);
    const secondSdk = new TestOnlySdk();
    const second = await startAt(secondSdk, dataDir);
    const restored = await getRun(second, started.id) as RunWithFollowUps;

    expect(followUp(restored, 'interrupted-follow').status).toBe('interrupted');
    expect(restored.roles.moderator.status).toBe('interrupted');
    expect(secondSdk.calls).toHaveLength(0);
    deliveryGate.resolve();
  });

  it('records a deduplicated failed follow-up when bounded Party context rejects before remote execution', async () => {
    const sdk = new TestOnlySdk();
    const server = await start(sdk);
    const started = await postStart(server, input({ mode: 'single', requestId: 'context-budget' }));
    await waitForTerminal(server, started.id);
    for (let index = 0; index < 6; index += 1) {
      await postFollowUp(server, started.id, {
        requestId: `context-${index}`, text: `${index}${'x'.repeat(19_900)}`, to: [], images: [],
      });
      await waitUntil(() => sdk.callsFor('moderator').length === index + 2);
    }
    const callsBeforeFailure = sdk.calls.length;
    const failedRequest = { requestId: 'context-failure', text: `7${'x'.repeat(19_900)}`, to: [], images: [] };

    expect((await postFollowUp(server, started.id, failedRequest)).status).toBe(200);
    await waitUntil(async () => followUp(await getRun(server, started.id) as RunWithFollowUps, 'context-failure').status === 'failed');
    const failed = followUp(await getRun(server, started.id) as RunWithFollowUps, 'context-failure');
    expect(failed.error).toContain('context budget');
    expect(sdk.calls).toHaveLength(callsBeforeFailure);
    expect((await postFollowUp(server, started.id, failedRequest)).status).toBe(200);
    await new Promise(resolve => setImmediate(resolve));
    expect(sdk.calls).toHaveLength(callsBeforeFailure);
  });
});

type RunWithFollowUps = RunSnapshot;

function followUp(run: RunWithFollowUps, requestId: string): FollowUpSnapshot {
  const result = run.followUps.find(item => item.requestId === requestId);
  if (!result) throw new Error(`Missing follow-up ${requestId}`);
  return result;
}

function input(overrides: Partial<StartInput> = {}): StartInput {
  return {
    requestId: 'request-1',
    stock: 'SYNTH',
    text: 'Assess the synthetic scenario.',
    images: [],
    machineId: 'machine-1',
    directory: '/workspace/project',
    agents: { moderator: 'codex', trend30: 'claude', structure10: 'gemini', timing1: 'opencode' },
    mode: 'consultation',
    ...overrides,
  };
}

async function postStart(server: PocServer, body: StartInput): Promise<RunSnapshot> {
  const response = await fetch(`${server.url}/api/consultations`, { method: 'POST', headers, body: JSON.stringify(body) });
  expect(response.status).toBe(200);
  return response.json() as Promise<RunSnapshot>;
}

async function postFollowUp(server: PocServer, id: string, body: {
  requestId: string; text: string; to: Array<'moderator' | 'trend30' | 'structure10' | 'timing1'>; images: ImageRef[];
}): Promise<Response> {
  return fetch(`${server.url}/api/consultations/${id}/messages`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
}

async function getRun(server: PocServer, id: string): Promise<RunSnapshot> {
  const response = await fetch(`${server.url}/api/consultations/${id}`, { headers });
  return response.json() as Promise<RunSnapshot>;
}

async function upload(server: PocServer, bytes: Uint8Array): Promise<ImageRef> {
  const response = await fetch(`${server.url}/api/assets`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'image/png', 'x-filename': 'chart.png' },
    body: Uint8Array.from(bytes).buffer,
  });
  return response.json() as Promise<ImageRef>;
}

async function waitForTerminal(server: PocServer, id: string): Promise<RunSnapshot> {
  let snapshot!: RunSnapshot;
  await waitUntil(async () => {
    const response = await fetch(`${server.url}/api/consultations/${id}`, { headers });
    snapshot = await response.json() as RunSnapshot;
    return snapshot.status !== 'running';
  });
  return snapshot;
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function readParty(server: PocServer, partyId: string): Promise<Array<PartyMessage & { text: string; images: ImageRef[] }>> {
  const list = await fetch(`${server.url}/api/parties`, { headers });
  const parties = (await list.json() as { parties: Array<{ id: string; key: string }> }).parties;
  const key = parties.find(party => party.id === partyId)?.key;
  if (!key) throw new Error('party key unavailable');
  const response = await fetch(`${server.url}/api/parties/${partyId}/messages`, { headers });
  const messages = (await response.json() as { messages: PartyMessage[] }).messages.filter(message => message.kind === 'message');
  return Promise.all(messages.map(async message => {
    const plaintext = await decryptText(key, message.text);
    if (!plaintext) throw new Error('party message did not decrypt');
    const envelope = JSON.parse(plaintext) as { text: string; images: ImageRef[] };
    return { ...message, text: envelope.text, images: envelope.images };
  }));
}
