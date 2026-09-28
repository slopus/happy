import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    ChannelHostRequestError,
    channelHostDirectories,
    createChannelHostSupervisor,
    resolveChannelHostEntry,
    spawnChannelHostChild,
    type ChannelHostChild,
    type ChannelHostInit,
} from './channelHostSupervisor';

class FakeChild extends EventEmitter implements ChannelHostChild {
    stdin = new PassThrough();
    stdout = new PassThrough();
    stderr = new PassThrough();
    written: Array<Record<string, unknown>> = [];
    signals: string[] = [];
    exited = false;

    constructor() {
        super();
        let buffer = '';
        this.stdin.on('data', (chunk: Buffer) => {
            buffer += chunk.toString('utf8');
            let newline = buffer.indexOf('\n');
            while (newline >= 0) {
                this.written.push(JSON.parse(buffer.slice(0, newline)));
                buffer = buffer.slice(newline + 1);
                newline = buffer.indexOf('\n');
            }
        });
    }

    send(message: Record<string, unknown>): void {
        this.stdout.write(`${JSON.stringify(message)}\n`);
    }

    kill(signal: NodeJS.Signals): boolean {
        this.signals.push(signal);
        if (signal === 'SIGKILL') this.exit();
        return true;
    }

    exit(): void {
        if (this.exited) return;
        this.exited = true;
        this.emit('exit', null, null);
    }
}

const init: ChannelHostInit = {
    v: 1,
    dataDir: '/home/u/.happy/channel-host',
    extensionsDir: '/home/u/.happy-channel-extensions',
    machine: { id: 'm-1', platform: 'darwin', hostname: 'box', homeDir: '/home/u', capabilities: { happyCliVersion: '1.0.0' } },
    happyBaseUrl: 'https://happy.example',
    happy: { token: 'SECRET-TOKEN', secret: null },
};

const ready = {
    t: 'ready', hostKey: 'host-key', fingerprint: 'aa:bb', custody: 'available', isolation: 'available', providers: ['telegram'],
};

const advertisement = {
    protocolVersion: 1, custody: 'available', isolation: 'available', providers: ['telegram'], hostKey: 'host-key', fingerprint: 'aa:bb',
};

describe('channelHostDirectories', () => {
    it('keeps adapters outside the happy home, which the host sandbox denies to adapter code', () => {
        expect(channelHostDirectories('/home/u/.happy')).toEqual({
            dataDir: '/home/u/.happy/channel-host',
            extensionsDir: '/home/u/.happy-channel-extensions',
        });
        // A custom HAPPY_HOME_DIR gets its own sibling, so two daemons never share adapters.
        expect(channelHostDirectories('/srv/happy-b/').extensionsDir).toBe('/srv/happy-b-channel-extensions');
    });
});

describe('resolveChannelHostEntry', () => {
    const present = new Set(['/cli/index.mjs', '/cli/channel-extension-host.mjs']);
    const deps = (nodeVersion: string, files = present) => ({
        nodeVersion,
        resolveManifest: () => '/cli/package.json',
        exists: (path: string) => files.has(path),
    });

    it('needs Node 22.13 or later, the version with the permission model the host isolates adapters with', () => {
        expect(resolveChannelHostEntry(deps('22.12.9'))).toEqual({ ok: false, code: 'NODE_TOO_OLD' });
        expect(resolveChannelHostEntry(deps('20.19.0'))).toEqual({ ok: false, code: 'NODE_TOO_OLD' });
        expect(resolveChannelHostEntry(deps('22.13.0'))).toEqual({ ok: true, entry: '/cli/index.mjs' });
        expect(resolveChannelHostEntry(deps('24.1.0'))).toEqual({ ok: true, entry: '/cli/index.mjs' });
    });

    it('needs a bundled saycode-cli that ships the adapter host next to its entry', () => {
        expect(resolveChannelHostEntry(deps('22.22.3', new Set(['/cli/index.mjs']))))
            .toEqual({ ok: false, code: 'HOST_MISSING' });
        expect(resolveChannelHostEntry({ ...deps('22.22.3'), resolveManifest: () => { throw new Error('nope'); } }))
            .toEqual({ ok: false, code: 'CLI_MISSING' });
    });
});

describe('createChannelHostSupervisor', () => {
    let children: FakeChild[];
    let advertisements: unknown[];
    let logs: string[];
    let handleRequest: ReturnType<typeof vi.fn>;

    const flush = async () => {
        for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    };

    const make = () => createChannelHostSupervisor({
        spawnChild: () => {
            const child = new FakeChild();
            children.push(child);
            return child;
        },
        buildInit: () => init,
        onAdvertisement: (value) => { advertisements.push(value); },
        handleRequest: handleRequest as never,
        log: (code) => { logs.push(code); },
    });

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        children = [];
        advertisements = [];
        logs = [];
        handleRequest = vi.fn();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('sends init as the first line on stdin, and advertises only after the child says ready', async () => {
        const supervisor = make();
        supervisor.start();
        await flush();

        expect(children).toHaveLength(1);
        expect(children[0].written[0]).toEqual({ t: 'init', init });
        expect(advertisements).toEqual([]);

        children[0].send(ready);
        await flush();
        expect(advertisements).toEqual([advertisement]);
    });

    it('does not advertise a ready that does not carry what Desktop needs to seal to the host', async () => {
        const supervisor = make();
        supervisor.start();
        children[0].send({ ...ready, hostKey: '' });
        await flush();
        expect(advertisements.filter(Boolean)).toEqual([]);
    });

    it('withdraws the advertisement when the child reports itself unavailable', async () => {
        const supervisor = make();
        supervisor.start();
        children[0].send(ready);
        await flush();
        children[0].send({ t: 'unavailable', reason: 'CUSTODY_UNAVAILABLE' });
        await flush();
        expect(advertisements.at(-1)).toBeUndefined();
        expect(logs).toContain('unavailable:CUSTODY_UNAVAILABLE');
    });

    it('restarts a crashed child with a backoff from 1s doubling to 60s, never running two', async () => {
        const supervisor = make();
        supervisor.start();
        children[0].send(ready);
        await flush();

        const delays: number[] = [];
        for (let crash = 0; crash < 8; crash++) {
            const before = children.length;
            children.at(-1)!.exit();
            await flush();
            expect(advertisements.at(-1)).toBeUndefined();
            let waited = 0;
            while (children.length === before) {
                await vi.advanceTimersByTimeAsync(500);
                waited += 500;
            }
            delays.push(waited);
            // The restart waited for the previous child to exit first.
            expect(children.slice(0, -1).every((child) => child.exited)).toBe(true);
        }
        expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    });

    it('retries a child that exited without custody only hourly, not on the crash backoff', async () => {
        const supervisor = make();
        supervisor.start();
        for (let attempt = 1; attempt <= 3; attempt++) {
            children.at(-1)!.send({ t: 'unavailable', reason: 'CUSTODY_UNAVAILABLE' });
            await flush();
            children.at(-1)!.exit();
            await flush();
            await vi.advanceTimersByTimeAsync(3_600_000 - 1);
            expect(children).toHaveLength(attempt);
            await vi.advanceTimersByTimeAsync(1);
            expect(children).toHaveLength(attempt + 1);
        }
        expect(logs).toContain('restart-scheduled:CUSTODY_UNAVAILABLE');
    });

    it.each(['NODE_TOO_OLD', 'INIT_INVALID'])('does not restart a child that exited as %s, which no retry can fix', async (reason) => {
        const supervisor = make();
        supervisor.start();
        children[0].send({ t: 'unavailable', reason });
        await flush();
        children[0].exit();
        await flush();
        await vi.advanceTimersByTimeAsync(24 * 3_600_000);
        expect(children).toHaveLength(1);
        expect(logs).toContain(`restart-abandoned:${reason}`);
    });

    it('goes back to the crash backoff once a retried child crashes for another reason', async () => {
        const supervisor = make();
        supervisor.start();
        children[0].send({ t: 'unavailable', reason: 'CUSTODY_UNAVAILABLE' });
        await flush();
        children[0].exit();
        await flush();
        await vi.advanceTimersByTimeAsync(3_600_000);
        expect(children).toHaveLength(2);
        children[1].exit();
        await flush();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(children).toHaveLength(3);
    });

    it('forwards a sealed settings call and returns the sealed result, without opening it', async () => {
        const supervisor = make();
        supervisor.start();
        children[0].send(ready);
        await flush();

        const answer = supervisor.call({ wire: { sealed: 'SEALED-CALL' } });
        await flush();
        const forwarded = children[0].written.find((message) => message.t === 'settings')!;
        expect(forwarded).toEqual({ t: 'settings', id: expect.any(String), wire: { sealed: 'SEALED-CALL' } });

        children[0].send({ t: 'settings-result', id: forwarded.id, wire: { sealed: 'SEALED-RESULT' } });
        await expect(answer).resolves.toEqual({ wire: { sealed: 'SEALED-RESULT' } });
        expect(logs.join(' ')).not.toContain('SEALED');
    });

    it('passes on the closed code a host sends for a call it could not open, and nothing else', async () => {
        const supervisor = make();
        supervisor.start();
        children[0].send(ready);
        await flush();
        const refused = supervisor.call({ wire: { sealed: 'SEALED-CALL' } });
        const first = children[0].written.find((message) => message.t === 'settings')!;
        children[0].send({ t: 'settings-result', id: first.id, wire: { sealed: '', error: 'ENVELOPE_EXPIRED' } });
        await expect(refused).resolves.toEqual({ wire: { sealed: '', error: 'ENVELOPE_EXPIRED' } });

        const odd = supervisor.call({ wire: { sealed: 'SEALED-CALL' } });
        const second = children[0].written.filter((message) => message.t === 'settings')[1];
        children[0].send({ t: 'settings-result', id: second.id, wire: { sealed: '', error: 'token 123:abc leaked' } });
        await expect(odd).resolves.toEqual({ wire: { sealed: '' } });
    });

    it('answers a settings call with closed codes: unavailable, malformed, and timed out', async () => {
        const supervisor = make();
        await expect(supervisor.call({ wire: { sealed: 'x' } }))
            .resolves.toEqual({ error: 'CHANNEL_HOST_UNAVAILABLE', code: 'CHANNEL_HOST_UNAVAILABLE' });

        supervisor.start();
        children[0].send(ready);
        await flush();
        await expect(supervisor.call({ wire: { sealed: 42 } }))
            .resolves.toEqual({ error: 'CHANNEL_HOST_INVALID_PARAMS', code: 'CHANNEL_HOST_INVALID_PARAMS' });

        const late = supervisor.call({ wire: { sealed: 'x' } });
        await vi.advanceTimersByTimeAsync(30_000);
        await expect(late).resolves.toEqual({ error: 'CHANNEL_HOST_TIMEOUT', code: 'CHANNEL_HOST_TIMEOUT' });
    });

    it('fails a pending settings call when the child dies', async () => {
        const supervisor = make();
        supervisor.start();
        children[0].send(ready);
        await flush();
        const pending = supervisor.call({ wire: { sealed: 'x' } });
        await flush();
        children[0].exit();
        await expect(pending).resolves.toEqual({ error: 'CHANNEL_HOST_UNAVAILABLE', code: 'CHANNEL_HOST_UNAVAILABLE' });
    });

    it('answers host requests with the handler value or its closed code', async () => {
        handleRequest.mockImplementation(async (method: string) => {
            if (method === 'dek') throw new ChannelHostRequestError('SESSION_UNKNOWN');
            if (method === 'spawn') return { sessionId: 's-1', dataEncryptionKey: 'env', dek: 'raw' };
            throw new Error('some internal text');
        });
        const supervisor = make();
        supervisor.start();
        children[0].send({ t: 'request', id: 'h1', method: 'spawn', params: { directory: '/w' } });
        children[0].send({ t: 'request', id: 'h2', method: 'dek', params: { sessionId: 's-9' } });
        children[0].send({ t: 'request', id: 'h3', method: 'other', params: {} });
        await flush();

        const replies = children[0].written.filter((message) => message.t === 'reply');
        expect(replies).toEqual(expect.arrayContaining([
            { t: 'reply', id: 'h1', ok: true, value: { sessionId: 's-1', dataEncryptionKey: 'env', dek: 'raw' } },
            { t: 'reply', id: 'h2', ok: false, code: 'SESSION_UNKNOWN' },
            { t: 'reply', id: 'h3', ok: false, code: 'DAEMON_FAILED' },
        ]));
        expect(handleRequest).toHaveBeenCalledWith('spawn', { directory: '/w' });
        expect(logs.join(' ')).not.toContain('some internal text');
    });

    it('never logs what the child writes to stderr', async () => {
        const supervisor = make();
        supervisor.start();
        children[0].stderr.write('leaked SECRET-TOKEN\n');
        await flush();
        expect(logs.join(' ')).not.toContain('SECRET');
    });

    it('stops by asking the child, and does not restart it', async () => {
        const supervisor = make();
        supervisor.start();
        children[0].send(ready);
        await flush();

        const stopped = supervisor.stop();
        await flush();
        expect(children[0].written.at(-1)).toEqual({ t: 'stop' });
        children[0].exit();
        await stopped;

        expect(advertisements.at(-1)).toBeUndefined();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(children).toHaveLength(1);
        expect(children[0].signals).toEqual([]);
    });

    it('kills a child that does not exit within 10s of stop', async () => {
        const supervisor = make();
        supervisor.start();
        await flush();
        let done = false;
        const stopped = supervisor.stop().then(() => { done = true; });
        await vi.advanceTimersByTimeAsync(9_999);
        expect(done).toBe(false);
        expect(children[0].signals).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        await stopped;
        expect(children[0].signals).toEqual(['SIGKILL']);
    });

    it('cancels a scheduled restart on stop', async () => {
        const supervisor = make();
        supervisor.start();
        children[0].exit();
        await flush();
        await supervisor.stop();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(children).toHaveLength(1);
    });
});

describe('spawnChannelHostChild', () => {
    it('gives the real child its credential on stdin only — never in argv or the environment', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'channel-host-spawn-'));
        try {
            const entry = join(dir, 'index.mjs');
            // Reports whether the token is visible anywhere but stdin, then waits for stop.
            writeFileSync(entry, [
                "import { createInterface } from 'node:readline';",
                "const lines = createInterface({ input: process.stdin });",
                "lines.on('line', (line) => {",
                "  const message = JSON.parse(line);",
                "  if (message.t === 'stop') process.exit(0);",
                "  if (message.t !== 'init') return;",
                "  const visible = (process.argv.join(' ') + JSON.stringify(process.env)).includes('SECRET-TOKEN');",
                "  process.stdout.write(JSON.stringify({ t: 'ready', custody: 'available', isolation: 'available', providers: [],",
                "    hostKey: visible ? 'leaked' : 'clean', fingerprint: message.init.happy.token === 'SECRET-TOKEN' ? 'got-init' : 'no-init' }) + '\\n');",
                "});",
            ].join('\n'));
            const advertised: unknown[] = [];
            const supervisor = createChannelHostSupervisor({
                spawnChild: () => spawnChannelHostChild(entry, dir),
                buildInit: () => init,
                onAdvertisement: (value) => { advertised.push(value); },
                handleRequest: async () => undefined,
                log: () => undefined,
            });
            supervisor.start();
            await vi.waitFor(() => expect(advertised[0]).toBeDefined(), { timeout: 10_000 });
            expect(advertised[0]).toMatchObject({ hostKey: 'clean', fingerprint: 'got-init' });
            await supervisor.stop();
            expect(advertised.at(-1)).toBeUndefined();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);
});
