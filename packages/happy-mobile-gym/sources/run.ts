import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID, sign } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import type { MobileGymCompletion, MobileGymCreateOptions, MobileGymManifest, MobileGymRunning, MobileGymStatus } from './contracts.js';
import { assertPrivate, canonicalDirectory, childEnvironment, exists, privateDirectory, privateRead, privateWrite } from './privateFiles.js';
import { assertPortFree, processStart, waitReady, type OwnedProcess } from './processes.js';

const exec = promisify(execFile);
const manifestName = 'manifest.json';
const leaseName = 'controller.lock';
type Auth = { token: string; secret: string };

function assertSupportedPlatform(): void {
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
        throw new Error('Mobile gym currently requires macOS or Linux private files and process groups.');
    }
}

function port(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1024 || value > 65535) {
        throw new Error('Ports must be explicit integers from 1024 through 65535.');
    }
    return value;
}

function owner(value: unknown): string {
    if (typeof value !== 'string' || value.trim() !== value || value.length < 1 || value.length > 128 || /[\x00-\x1f\x7f]/u.test(value)) {
        throw new Error('Owner must be a nonempty single-line label of at most 128 characters.');
    }
    return value;
}

function manifestBuild(options: {
    runId: string; runRoot: string; repositoryRoot: string; owner: string; createdAt: string;
    source: MobileGymManifest['source']; serverPort: number; metroPort: number;
}): MobileGymManifest {
    if (port(options.serverPort) === port(options.metroPort)) throw new Error('Server and Metro require different ports.');
    return {
        version: 1, kind: 'happy-mobile-gym', runId: options.runId, owner: owner(options.owner),
        createdAt: options.createdAt, runRoot: options.runRoot, repositoryRoot: options.repositoryRoot,
        source: options.source,
        server: { port: options.serverPort, url: `http://127.0.0.1:${options.serverPort}` },
        metro: { port: options.metroPort, url: `http://127.0.0.1:${options.metroPort}` },
        paths: {
            manifest: join(options.runRoot, manifestName),
            credentials: join(options.runRoot, 'auth.json'),
            database: join(options.runRoot, 'server', 'pglite'),
            serverLog: join(options.runRoot, 'logs', 'server.log'),
            metroLog: join(options.runRoot, 'logs', 'metro.log'),
            migrationLog: join(options.runRoot, 'logs', 'migration.log'),
        },
    };
}

async function sourceRead(repositoryRoot: string, runRoot: string): Promise<MobileGymManifest['source']> {
    const options = { cwd: repositoryRoot, env: childEnvironment(runRoot), maxBuffer: 32 * 1024 * 1024 };
    const [head, diff, status] = await Promise.all([
        exec('git', ['rev-parse', 'HEAD'], options),
        exec('git', ['diff', '--binary', 'HEAD'], options),
        exec('git', ['status', '--porcelain', '--untracked-files=normal'], options),
    ]);
    return {
        commit: head.stdout.trim(),
        trackedDiffSha256: createHash('sha256').update(diff.stdout).digest('hex'),
        dirty: status.stdout.length > 0,
    };
}

/** Create private files only. Does not start a listener, migrate, seed, or touch a device. */
export async function runCreate(options: MobileGymCreateOptions): Promise<MobileGymManifest> {
    assertSupportedPlatform();
    port(options.serverPort); port(options.metroPort); owner(options.owner);
    if (options.serverPort === options.metroPort) throw new Error('Server and Metro require different ports.');
    const repositoryRoot = await canonicalDirectory(options.repositoryRoot);
    for (const name of ['happy-app', 'happy-server']) {
        if (!(await exists(join(repositoryRoot, 'packages', name, 'package.json')))) throw new Error('Expected a Happy mobile repository root.');
    }
    const context = join(repositoryRoot, '.context');
    await mkdir(context, { recursive: true });
    if (await canonicalDirectory(context) !== context) throw new Error('The scratch directory may not be redirected.');
    const runs = join(context, 'mobile-gym');
    await privateDirectory(runs);
    const runId = `run-${randomUUID()}`;
    const runRoot = join(runs, runId);
    await mkdir(runRoot, { mode: 0o700 });
    for (const directory of ['home', 'tmp', 'server', 'logs']) await privateDirectory(join(runRoot, directory));
    const manifest = manifestBuild({
        ...options, repositoryRoot, runId, runRoot, createdAt: new Date().toISOString(),
        source: await sourceRead(repositoryRoot, runRoot),
    });
    // Persist identity before account creation. Retrying auth always authenticates
    // the same account, even if a process dies between the HTTP reply and saving it.
    await privateWrite(join(runRoot, 'account-seed'), randomBytes(32).toString('base64url'));
    await privateWrite(join(runRoot, 'master-secret'), randomBytes(32).toString('base64url'));
    await privateWrite(manifest.paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
}

/** Validate the explicit owner manifest; never follow a current-run pointer. */
export async function runOpen(input: string): Promise<MobileGymManifest> {
    const runRoot = resolve(input);
    if (await canonicalDirectory(runRoot) !== runRoot) throw new Error('Run root may not be a symlink.');
    await assertPrivate(runRoot, true);
    const value = JSON.parse(await privateRead(join(runRoot, manifestName))) as Partial<MobileGymManifest>;
    if (typeof value.repositoryRoot !== 'string' || typeof value.runId !== 'string'
        || !/^run-[0-9a-f-]{36}$/u.test(value.runId)
        || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
        || typeof value.source?.commit !== 'string' || !/^[0-9a-f]{40,64}$/u.test(value.source.commit)
        || typeof value.source.trackedDiffSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.source.trackedDiffSha256)
        || typeof value.source.dirty !== 'boolean') throw new Error('Invalid mobile gym provenance manifest.');
    const repositoryRoot = await canonicalDirectory(value.repositoryRoot);
    if (runRoot !== join(repositoryRoot, '.context', 'mobile-gym', value.runId) || basename(runRoot) !== value.runId) {
        throw new Error('Run manifest does not own this directory.');
    }
    await assertPrivate(dirname(runRoot), true);
    const expected = manifestBuild({
        runRoot, repositoryRoot, runId: value.runId, owner: owner(value.owner), createdAt: value.createdAt,
        source: { commit: value.source.commit, trackedDiffSha256: value.source.trackedDiffSha256, dirty: value.source.dirty },
        serverPort: port(value.server?.port), metroPort: port(value.metro?.port),
    });
    if (!isDeepStrictEqual(value, expected)) throw new Error('Invalid mobile gym manifest paths or fields.');
    return expected;
}

/** File status only: deliberately does not claim a stale PID or lock is a live service. */
export async function runStatus(runRoot: string): Promise<MobileGymStatus> {
    const manifest = await runOpen(runRoot);
    return {
        manifest,
        controllerLockPresent: await exists(join(manifest.runRoot, leaseName)),
        credentialsPresent: await exists(manifest.paths.credentials),
    };
}

async function accountAuthenticate(manifest: MobileGymManifest, signal?: AbortSignal): Promise<Auth> {
    const seed = Buffer.from(await privateRead(join(manifest.runRoot, 'account-seed')), 'base64url');
    if (seed.length !== 32) throw new Error('Invalid private account seed.');
    const key = createPrivateKey({
        key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
        format: 'der', type: 'pkcs8',
    });
    const publicKey = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32);
    const challenge = randomBytes(32);
    const response = await fetch(`${manifest.server.url}/v1/auth`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey: publicKey.toString('base64'), challenge: challenge.toString('base64'), signature: sign(null, challenge, key).toString('base64') }),
    });
    if (!response.ok) throw new Error(`Harness account authentication failed (HTTP ${response.status}).`);
    const result = await response.json() as { token?: unknown };
    if (typeof result.token !== 'string' || !result.token) throw new Error('Harness authentication returned no token.');
    const auth = { token: result.token, secret: seed.toString('base64url') };
    const temporary = join(manifest.runRoot, `auth-${randomUUID()}.tmp`);
    if (await exists(manifest.paths.credentials)) await assertPrivate(manifest.paths.credentials);
    await privateWrite(temporary, `${JSON.stringify(auth)}\n`);
    await rename(temporary, manifest.paths.credentials);
    return auth;
}

/** Owns migration, server, account auth and Metro. No fixtures or device actions. */
export async function runStart(runRoot: string, options: { readonly signal?: AbortSignal } = {}): Promise<MobileGymRunning> {
    assertSupportedPlatform();
    const manifest = await runOpen(runRoot);
    options.signal?.throwIfAborted();
    for (const directory of ['home', 'tmp', 'server', 'logs']) await assertPrivate(join(manifest.runRoot, directory), true);
    if (await exists(manifest.paths.database)) await canonicalDirectory(manifest.paths.database).then((path) => {
        if (path !== manifest.paths.database) throw new Error('Database directory may not be redirected.');
    });
    const lease = join(manifest.runRoot, leaseName);
    // Never inspect a stored PID and kill it: only handles spawned in this call
    // are stoppable. Stale leases fail closed and require an owner's inspection.
    const leaseContents = `${JSON.stringify({ version: 1, owner: manifest.owner, controllerPid: process.pid, nonce: randomUUID() })}\n`;
    await privateWrite(lease, leaseContents).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'EEXIST') throw new Error('This run already has a controller lock. Inspect the owner before recovery; it will not be stolen.');
        throw error;
    });
    const children: OwnedProcess[] = [];
    let spawning: Promise<OwnedProcess> | undefined;
    let stopping: Promise<void> | undefined;
    let complete!: (value: MobileGymCompletion) => void;
    const finished = new Promise<MobileGymCompletion>((resolve) => { complete = resolve; });
    const stop = (completion: MobileGymCompletion): Promise<void> => stopping ??= (async () => {
        options.signal?.removeEventListener('abort', abort);
        try {
            // An abort may arrive while opening a child's log. Register that
            // child before taking the cleanup snapshot; never orphan a spawn.
            await spawning?.catch(() => {});
            const stopped = await Promise.allSettled([...children].reverse().map((child) => child.stop()));
            if (stopped.some((result) => result.status === 'rejected')) throw new Error('Owned process cleanup failed.');
            if (await privateRead(lease) !== leaseContents) throw new Error('Controller lock changed; refusing to remove another owner’s lock.');
            await unlink(lease);
            complete(completion);
        } catch {
            complete({ reason: 'failed', message: 'Harness cleanup failed; inspect owned processes and the retained controller lock.' });
            throw new Error('Harness cleanup failed; controller lock retained.');
        }
    })();
    const abort = () => { void stop({ reason: 'stopped' }).catch(() => {}); };
    options.signal?.addEventListener('abort', abort, { once: true });
    const spawnOwned = async (args: string[], cwd: string, env: NodeJS.ProcessEnv, log: string) => {
        options.signal?.throwIfAborted();
        if (stopping) throw new Error('Harness is stopping.');
        spawning = processStart({ args, cwd, env, log }).then((child) => {
            children.push(child);
            return child;
        });
        return await spawning;
    };
    try {
        await Promise.all([assertPortFree(manifest.server.port), assertPortFree(manifest.metro.port)]);
        const app = join(manifest.repositoryRoot, 'packages', 'happy-app');
        const server = join(manifest.repositoryRoot, 'packages', 'happy-server');
        const serverRequire = createRequire(join(server, 'package.json'));
        const appRequire = createRequire(join(app, 'package.json'));
        // The tsx CLI creates an IPC socket under TMPDIR, which exceeds macOS
        // socket path limits in a named workspace. Its loader needs no socket.
        const tsx = pathToFileURL(serverRequire.resolve('tsx')).href;
        const expo = appRequire.resolve('expo/bin/cli');
        const masterSecret = await privateRead(join(manifest.runRoot, 'master-secret'));
        if (Buffer.from(masterSecret, 'base64url').length !== 32) throw new Error('Invalid private server master secret.');
        const base = childEnvironment(manifest.runRoot);
        const serverEnv = {
            ...base, HAPPY_HARNESS_MODE: '1', HOST: '127.0.0.1', PORT: String(manifest.server.port),
            HANDY_MASTER_SECRET: masterSecret, DATA_DIR: join(manifest.runRoot, 'server'),
            PGLITE_DIR: manifest.paths.database, DB_PROVIDER: 'pglite', DATABASE_URL: '', METRICS_ENABLED: 'false',
        };
        const standalone = join(server, 'sources', 'standalone.ts');
        const migration = await spawnOwned(['--import', tsx, standalone, 'migrate'], server, serverEnv, manifest.paths.migrationLog);
        const migrated = await migration.done;
        if (migrated.code !== 0) throw new Error('Harness database migration failed; inspect its private log.');
        await migration.stop();
        children.splice(children.indexOf(migration), 1);
        const serverChild = await spawnOwned(['--import', tsx, standalone, 'serve'], server, serverEnv, manifest.paths.serverLog);
        await waitReady(serverChild, `${manifest.server.url}/v1/account/profile`, 'server', options.signal);
        const auth = await accountAuthenticate(manifest, options.signal);
        const metroChild = await spawnOwned([expo, 'start', '--dev-client', '--localhost', '--port', String(manifest.metro.port)], app, {
            ...base, APP_ENV: 'development', HAPPY_HARNESS_MODE: '1', EXPO_PUBLIC_HARNESS_MODE: '1',
            EXPO_PUBLIC_SERVER_URL: manifest.server.url, EXPO_PUBLIC_HAPPY_SERVER_URL: manifest.server.url,
            EXPO_PUBLIC_DISABLE_ANALYTICS: '1', EXPO_PUBLIC_HARNESS_DEV_TOKEN: auth.token,
            EXPO_PUBLIC_HARNESS_DEV_SECRET: auth.secret, NODE_OPTIONS: '--dns-result-order=ipv4first',
        }, manifest.paths.metroLog);
        await waitReady(metroChild, `${manifest.metro.url}/status`, 'metro', options.signal);
        options.signal?.throwIfAborted();
        if (serverChild.exited() || metroChild.exited()) throw new Error('A harness service exited during startup.');
        for (const [name, child] of [['server', serverChild], ['Metro', metroChild]] as const) {
            void child.done.then(() => stop({ reason: 'failed', message: `${name} exited; inspect its private log.` })).catch(() => {});
        }
        return { manifest, finished, stop: () => stop({ reason: 'stopped' }) };
    } catch (error) {
        await stop({ reason: 'failed', message: error instanceof Error ? error.message : 'Harness startup failed.' });
        throw error;
    }
}