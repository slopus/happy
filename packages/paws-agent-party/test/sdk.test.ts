import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createRealPawsSdk, type PawsSdkBoundary } from '../src/server/sdk.js';

const servers: Server[] = [];
const sdks: PawsSdkBoundary[] = [];

afterEach(async () => {
  await Promise.all(sdks.splice(0).map(sdk => sdk.dispose()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

describe('real Paws SDK account-link lifecycle', () => {
  it('does not begin recovery authentication after immediate cancellation', async () => {
    let requests = 0;
    const server = createServer(request => { requests += 1; request.resume(); });
    servers.push(server);
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server address unavailable');
    const sdk = createRealPawsSdk();
    sdks.push(sdk);

    const recovery = sdk.recover(`http://127.0.0.1:${address.port}`, 'AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AA');
    await sdk.disconnect();

    expect(await recovery).toEqual({ state: 'disconnected' });
    expect(requests).toBe(0);
  });

  it('keeps a cancelled initial account-link operation from replacing disconnected state', async () => {
    const requestArrived = deferred<void>();
    const server = createServer(request => {
      requestArrived.resolve();
      request.resume();
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server address unavailable');
    const sdk = createRealPawsSdk();
    sdks.push(sdk);

    const pendingLink = sdk.link(`http://127.0.0.1:${address.port}`);
    await requestArrived.promise;
    await sdk.disconnect();
    const staleResult = await pendingLink;

    expect(staleResult).toEqual({ state: 'disconnected' });
    expect(sdk.status()).toEqual({ state: 'disconnected' });
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
