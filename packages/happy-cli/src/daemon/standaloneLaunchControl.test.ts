import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { StandaloneLaunchControl } from './standaloneLaunchControl';
import { SessionLaunchControl } from '../sessionDrain/sessionLaunchControl';
import { RuntimeProducerGate } from '../sessionDrain/runtimeProducerGate';
import { consumeStandaloneLaunchBootstrap, launchAuthProof, type StandaloneLaunchBootstrap } from './standaloneLaunchProtocol';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const parent = await StandaloneLaunchControl.open('instance-1');
  cleanup.push(() => parent.close());
  const bootstrap = parent.reserve('launch-1');
  const gate = new RuntimeProducerGate({ hasUndeliveredInput: () => false,
    canFreezeInbound: () => true, freezeInbound: () => true, stopLoop: () => { gate.loopExited(); } });
  const storage = { tracksShutdownStorage: true, flushForShutdown: vi.fn(async () => ({ stored: true as const, revision: 1 })),
    isStorageConfirmationCurrent: () => true };
  const provider = { freezeInputForShutdown: vi.fn(() => true), interruptTurn: vi.fn(async () => {}),
    endInputAndAwaitExit: vi.fn(async () => ({ exited: true, code: 0, signal: null })),
    waitForOutputDrain: vi.fn(async () => {}), cancelOutputDrain: vi.fn(), finishShutdownObservation: vi.fn() };
  return { parent, bootstrap, gate, storage, provider };
}
it('consumes bootstrap before downstream spawns and scrubs malformed input too', async () => {
  const f = await fixture();
  const env = { HAPPY_STANDALONE_LAUNCH_V1: JSON.stringify(f.bootstrap) };
  expect(consumeStandaloneLaunchBootstrap(env)).toEqual(f.bootstrap);
  expect(env.HAPPY_STANDALONE_LAUNCH_V1).toBeUndefined();
  const malformed = { HAPPY_STANDALONE_LAUNCH_V1: 'secret-not-json' };
  expect(() => consumeStandaloneLaunchBootstrap(malformed)).toThrow('Invalid standalone launch bootstrap');
  expect(malformed.HAPPY_STANDALONE_LAUNCH_V1).toBeUndefined();
});
it('uses a per-launch secret and rejects the daemon bearer or another launch identity', async () => {
  const f = await fixture();
  const rejected = (headers: Record<string, string>) => new Promise<number>(resolve => {
    const socket = new WebSocket(`ws://127.0.0.1:${f.bootstrap.port}/launch-control/v1`, { headers });
    socket.on('error', () => {});
    socket.on('unexpected-response', (_req, response) => { response.resume(); socket.terminate(); resolve(response.statusCode!); });
  });
  expect(await rejected({ Authorization: 'Bearer daemon-secret', 'x-launch-id': 'launch-1', 'x-instance-id': 'instance-1' })).toBe(401);
  expect(await rejected({ Authorization: `Bearer ${f.bootstrap.secret}`, 'x-launch-id': 'different', 'x-instance-id': 'instance-1' })).toBe(401);
});
it('composes authenticated receipt, explicit release, and delivered outcome without claiming OS exit', async () => {
  const f = await fixture();
  const child = new SessionLaunchControl(f.bootstrap, f.provider, f.storage, f.gate);
  cleanup.push(() => child.close());
  await child.ready();
  const proof = await f.parent.drain('launch-1', new AbortController().signal, { remainingMs: () => 30000 });
  expect(proof).toEqual({ stored: true, releaseAcknowledged: true });
  expect(await f.gate.waitForShutdownDecision()).toBe('confirmed');
  expect(f.storage.flushForShutdown).toHaveBeenCalledOnce();
  expect(f.provider.freezeInputForShutdown).toHaveBeenCalledOnce();
});
it('never releases an unclean provider receipt', async () => {
  const f = await fixture(); f.provider.endInputAndAwaitExit.mockResolvedValue({ exited: true, code: 1, signal: null });
  const child = new SessionLaunchControl(f.bootstrap, f.provider, f.storage, f.gate);
  cleanup.push(() => child.close()); await child.ready();
  expect(await f.parent.drain('launch-1', new AbortController().signal, { remainingMs: () => 30000 })).toEqual({ stored: false, releaseAcknowledged: false });
  expect(await f.gate.waitForShutdownDecision()).toBe('blocked');
  expect(f.storage.flushForShutdown).not.toHaveBeenCalled();
});
it('reserves reply and runtime/Job time before asking the provider to drain', async () => {
  const f = await fixture();
  const child = new SessionLaunchControl(f.bootstrap, f.provider, f.storage, f.gate);
  cleanup.push(() => child.close()); await child.ready();
  expect(await f.parent.drain('launch-1', new AbortController().signal, { remainingMs: () => 5000 })).toEqual({ stored: false, releaseAcknowledged: false });
  expect(f.provider.freezeInputForShutdown).not.toHaveBeenCalled();
});
it('blocks a frozen runtime if its parent disappears before confirmation', async () => {
  const f = await fixture();
  f.provider.waitForOutputDrain.mockImplementation(() => new Promise(() => {}));
  const child = new SessionLaunchControl(f.bootstrap, f.provider, f.storage, f.gate);
  cleanup.push(() => child.close()); await child.ready();
  const draining = f.parent.drain('launch-1', new AbortController().signal, { remainingMs: () => 30000 });
  await vi.waitFor(() => expect(f.provider.freezeInputForShutdown).toHaveBeenCalledOnce());
  await f.parent.close();
  expect(await draining).toEqual({ stored: false, releaseAcknowledged: false });
  expect(await f.gate.waitForShutdownDecision()).toBe('blocked');
});

it('does not send the launch secret to a process that has taken over the port', async () => {
  const f = await fixture();
  const fake = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => fake.once('listening', resolve));
  cleanup.push(() => new Promise<void>(resolve => { for (const socket of fake.clients) socket.terminate(); fake.close(() => resolve()); }));
  let authorization = '';
  fake.on('connection', (socket, req) => {
    authorization = req.headers.authorization ?? '';
    socket.send(JSON.stringify({ type: 'authenticated', nonce: req.headers['x-launch-nonce'], proof: '0'.repeat(64) }));
  });
  const child = new SessionLaunchControl({ ...f.bootstrap, port: (fake.address() as AddressInfo).port }, f.provider, f.storage, f.gate);
  cleanup.push(() => child.close());
  await expect(child.ready()).rejects.toThrow('control');
  expect(authorization).not.toContain(f.bootstrap.secret);
  expect(f.provider.freezeInputForShutdown).not.toHaveBeenCalled();
});
it('waits for the actual child decision if proof becomes stale after intent', async () => {
  const f = await fixture(); let checks = 0;
  f.storage.isStorageConfirmationCurrent = () => ++checks < 4;
  const child = new SessionLaunchControl(f.bootstrap, f.provider, f.storage, f.gate);
  cleanup.push(() => child.close()); await child.ready();
  expect(await f.parent.drain('launch-1', new AbortController().signal, { remainingMs: () => 30000 })).toEqual({ stored: false, releaseAcknowledged: false });
  expect(await f.gate.waitForShutdownDecision()).toBe('blocked');
});
it('allows a new request after a mutation-free refusal', async () => {
  const f = await fixture(); f.provider.freezeInputForShutdown.mockReturnValueOnce(false);
  const child = new SessionLaunchControl(f.bootstrap, f.provider, f.storage, f.gate);
  cleanup.push(() => child.close()); await child.ready();
  expect(await f.parent.drain('launch-1', new AbortController().signal, { remainingMs: () => 30000 })).toEqual({ stored: false, releaseAcknowledged: false });
  expect(await f.parent.drain('launch-1', new AbortController().signal, { remainingMs: () => 30000 })).toEqual({ stored: true, releaseAcknowledged: true });
});
it('reclaims transport capacity only when the launch owner explicitly forgets an entry', async () => {
  const f = await fixture();
  for (let i = 1; i < 256; i++) f.parent.reserve(`entry-${i}`);
  expect(() => f.parent.reserve('overflow')).toThrow('reservation');
  f.parent.forget('entry-1');
  expect(f.parent.reserve('next').launchId).toBe('next');
});

async function controlledChild(bootstrap: StandaloneLaunchBootstrap) {
  const nonce = 'a'.repeat(64);
  const socket = new WebSocket(`ws://127.0.0.1:${bootstrap.port}/launch-control/v1`, { headers: {
    'x-launch-id': bootstrap.launchId, 'x-instance-id': bootstrap.instanceId, 'x-launch-nonce': nonce,
    'x-launch-proof': launchAuthProof(bootstrap, 'client', nonce),
  } });
  cleanup.push(() => socket.terminate());
  await new Promise<void>((resolve, reject) => { socket.once('message', () => resolve()); socket.once('error', reject); });
  socket.send(JSON.stringify({ type: 'ready', launchId: bootstrap.launchId, instanceId: bootstrap.instanceId }));
  return {
    nextDrain: () => new Promise<{ nonce: string }>(resolve => {
      const message = (raw: Buffer) => {
        const command = JSON.parse(raw.toString());
        if (command.type === 'drain') { socket.removeListener('message', message); resolve(command); }
      };
      socket.on('message', message);
    }),
    refuse: async (requestNonce: string) => {
      socket.send(JSON.stringify({ type: 'receipt', launchId: bootstrap.launchId, nonce: requestNonce,
        stored: false, ownership: 'none', reason: null }));
      // The server processes the preceding data frame before returning this pong.
      await new Promise<void>(resolve => { socket.once('pong', () => resolve()); socket.ping(); });
    },
  };
}
it('ends the parent transport deadline with 5500ms left for native exit and journal persistence', async () => {
  const f = await fixture(); const child = await controlledChild(f.bootstrap);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const command = child.nextDrain();
  const operation = f.parent.drain('launch-1', new AbortController().signal, { remainingMs: () => 30000 });
  await command;
  let settled = false; void operation.then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(24499); expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await operation).toEqual({ stored: false, releaseAcknowledged: false });
});
it('retries a late mutation-free refusal without letting its retired nonce replace a newer drain', async () => {
  const f = await fixture(); const child = await controlledChild(f.bootstrap);
  const abort = new AbortController(); const firstCommand = child.nextDrain();
  const first = f.parent.drain('launch-1', abort.signal, { remainingMs: () => 30000 });
  const retired = await firstCommand; abort.abort();
  expect(await first).toEqual({ stored: false, releaseAcknowledged: false });
  expect(f.parent.drain('launch-1', new AbortController().signal, { remainingMs: () => 30000 })).toBe(first);
  await child.refuse(retired.nonce);
  const secondCommand = child.nextDrain();
  const second = f.parent.drain('launch-1', new AbortController().signal, { remainingMs: () => 30000 });
  expect(second).not.toBe(first); const current = await secondCommand;
  await child.refuse(retired.nonce);
  expect(f.parent.drain('launch-1', new AbortController().signal, { remainingMs: () => 30000 })).toBe(second);
  await child.refuse(current.nonce);
  expect(await second).toEqual({ stored: false, releaseAcknowledged: false });
});

it('refuses pre-bind drain without mutation and accepts a retry after binding the real runtime', async () => {
  const f = await fixture();
  const child = await SessionLaunchControl.connect(f.bootstrap);
  cleanup.push(() => child.close());
  expect(await f.parent.drain('launch-1', new AbortController().signal, { remainingMs: () => 30000 }))
    .toEqual({ stored: false, releaseAcknowledged: false });
  expect(f.provider.freezeInputForShutdown).not.toHaveBeenCalled();
  expect(f.storage.flushForShutdown).not.toHaveBeenCalled();
  expect(f.gate.isFrozen()).toBe(false);
  child.bind(f.provider, f.storage, f.gate);
  expect(() => child.bind(f.provider, f.storage, f.gate)).toThrow('binding');
  expect(await f.parent.drain('launch-1', new AbortController().signal, { remainingMs: () => 30000 }))
    .toEqual({ stored: true, releaseAcknowledged: true });
  expect(await f.gate.waitForShutdownDecision()).toBe('confirmed');
});
