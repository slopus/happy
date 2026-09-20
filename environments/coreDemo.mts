/**
 * Local-only server and debug-app startup for the synchronized desktop/phone
 * recording. This file is a developer launcher, not an app import.
 *
 * Security boundary:
 * - the server and Expo bind to loopback and use per-environment data paths;
 * - the server master secret is supplied by HAPPY_DEMO_MASTER_SECRET or a
 *   private, generated per-environment file;
 * - the child environment is an allowlist, so host cloud/Git credentials and
 *   S3 settings cannot leak into the recording server or Metro;
 * - auth credentials are passed only to the debug Metro process through
 *   demo-specific EXPO_PUBLIC_DEMO_DEV_* startup variables; the app requires
 *   both __DEV__ and the exact demo-mode marker before using them;
 * - no fixture sessions, RPC responses, or mobile UI state are injected.
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createEnvironment } from './environments.ts';
import type { EnvironmentConfig } from './environments.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pointer = join(root, '.context', 'core-demo.json');
const app = join(root, 'packages', 'happy-app');
const server = join(root, 'packages', 'happy-server');
const appRequire = createRequire(join(app, 'package.json'));
const command = process.argv[2];

type DemoAuth = { token: string; secret: string };

const privateFile = async (file: string, contents: string) => {
    await writeFile(file, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmod(file, 0o600);
};

const assertPrivate = async (file: string, label: string) => {
    const details = await stat(file);
    if ((details.mode & 0o077) !== 0) {
        throw new Error(`${label} is readable by group or other users: ${file}`);
    }
};

const readPrivate = async (file: string, label: string) => {
    await assertPrivate(file, label);
    return readFile(file, 'utf8');
};

const readDemoConfig = async () => {
    const { name } = JSON.parse(await readFile(pointer, 'utf8')) as { name?: unknown };
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
        throw new Error('The core demo environment pointer is invalid. Run the new command again.');
    }

    const directory = join(root, 'environments', 'data', 'envs', name);
    const config = JSON.parse(await readFile(join(directory, 'environment.json'), 'utf8')) as EnvironmentConfig;
    if (
        config.name !== name
        || !Number.isInteger(config.serverPort)
        || !Number.isInteger(config.expoPort)
        || config.serverPort < 1
        || config.serverPort > 65535
        || config.expoPort < 1
        || config.expoPort > 65535
        || config.serverPort === config.expoPort
        || config.isolated !== true
    ) {
        throw new Error('The core demo environment configuration is invalid or not isolated.');
    }
    const serverUrl = `http://127.0.0.1:${config.serverPort}`;
    return { config, directory, serverUrl };
};

const demoMasterSecret = async (directory: string) => {
    const supplied = process.env.HAPPY_DEMO_MASTER_SECRET;
    if (supplied) {
        if (supplied.length < 32) throw new Error('HAPPY_DEMO_MASTER_SECRET must be at least 32 characters.');
        return supplied;
    }

    const file = join(directory, 'core-demo-master-secret');
    try {
        const existing = (await readPrivate(file, 'Core demo master secret')).trim();
        if (existing.length < 32) throw new Error(`Core demo master secret is too short: ${file}`);
        return existing;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const generated = randomBytes(32).toString('base64url');
        try {
            await privateFile(file, `${generated}\n`);
            return generated;
        } catch (writeError) {
            if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
            const existing = (await readPrivate(file, 'Core demo master secret')).trim();
            if (existing.length < 32) throw new Error(`Core demo master secret is too short: ${file}`);
            return existing;
        }
    }
};

const demoAuth = async (directory: string): Promise<DemoAuth> => {
    const file = join(directory, 'core-demo-auth.json');
    const value = JSON.parse(await readPrivate(file, 'Core demo auth')) as Partial<DemoAuth>;
    if (typeof value.token !== 'string' || typeof value.secret !== 'string' || !value.token || !value.secret) {
        throw new Error(`Core demo auth is invalid: ${file}`);
    }
    return { token: value.token, secret: value.secret };
};

const childEnvironment = async (directory: string): Promise<NodeJS.ProcessEnv> => {
    const home = join(directory, 'process-home');
    const temp = join(directory, 'process-tmp');
    await Promise.all([
        mkdir(home, { recursive: true, mode: 0o700 }),
        mkdir(temp, { recursive: true, mode: 0o700 }),
    ]);
    await Promise.all([chmod(home, 0o700), chmod(temp, 0o700)]);
    // Keep the package manager usable while excluding ambient credentials,
    // cloud endpoints, Git configuration, and arbitrary parent variables.
    return {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        LANG: process.env.LANG,
        LC_ALL: process.env.LC_ALL,
        TERM: process.env.TERM,
        CI: process.env.CI,
        HOME: home,
        TMPDIR: temp,
        TMP: temp,
        TEMP: temp,
        XDG_CONFIG_HOME: join(home, 'config'),
        XDG_CACHE_HOME: join(home, 'cache'),
        XDG_DATA_HOME: join(home, 'data'),
    };
};

const runChild = (cwd: string, args: string[], env: NodeJS.ProcessEnv) => {
    const child = spawn('pnpm', args, { cwd, env, stdio: 'inherit' });
    child.on('exit', (code, signal) => {
        if (signal) process.kill(process.pid, signal);
        else process.exit(code ?? 1);
    });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => child.kill(signal));
    }
};

if (command === 'new') {
    const suppliedMasterSecret = process.env.HAPPY_DEMO_MASTER_SECRET;
    if (suppliedMasterSecret && suppliedMasterSecret.length < 32) {
        throw new Error('HAPPY_DEMO_MASTER_SECRET must be at least 32 characters.');
    }
    const masterSecret = suppliedMasterSecret ?? randomBytes(32).toString('base64url');
    const name = await createEnvironment({ noSwitch: true, isolated: true, masterSecret });
    const directory = join(root, 'environments', 'data', 'envs', name);
    await privateFile(join(directory, 'core-demo-master-secret'), `${masterSecret}\n`);
    await mkdir(dirname(pointer), { recursive: true });
    await writeFile(pointer, JSON.stringify({ name }) + '\n', { encoding: 'utf8', mode: 0o600 });
    await chmod(pointer, 0o600);
} else {
    const { config, directory, serverUrl } = await readDemoConfig();

    if (command === 'seed') {
        const authPath = join(directory, 'core-demo-auth.json');
        if (await readFile(authPath).then(() => true, () => false)) {
            throw new Error('Demo account already exists; refusing to create another account.');
        }
        const sodium = appRequire('libsodium-wrappers');
        await sodium.ready;
        const secret: Uint8Array = sodium.randombytes_buf(32);
        const keys = sodium.crypto_sign_seed_keypair(secret);
        const challenge: Uint8Array = sodium.randombytes_buf(32);
        const b64 = (value: Uint8Array) => Buffer.from(value).toString('base64');
        const response = await fetch(`${serverUrl}/v1/auth`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                publicKey: b64(keys.publicKey),
                challenge: b64(challenge),
                signature: b64(sodium.crypto_sign_detached(challenge, keys.privateKey)),
            }),
        });
        if (!response.ok) throw new Error(`Demo authentication failed: ${response.status}`);
        const { token } = await response.json() as { token?: unknown };
        if (typeof token !== 'string' || !token) throw new Error('Demo authentication returned no token.');
        await privateFile(authPath, JSON.stringify({ token, secret: Buffer.from(secret).toString('base64url') }) + '\n');
        console.log('Fresh local demo account authenticated. No sessions seeded.');
    } else if (command === 'server' || command === 'metro') {
        const base = await childEnvironment(directory);
        if (command === 'server') {
            runChild(server, ['standalone', 'serve'], {
                ...base,
                NODE_ENV: 'development',
                HAPPY_DEMO_MODE: '1',
                HOST: '127.0.0.1',
                PORT: String(config.serverPort),
                HANDY_MASTER_SECRET: await demoMasterSecret(directory),
                DATA_DIR: join(directory, 'server'),
                PGLITE_DIR: join(directory, 'server', 'pglite'),
                DATABASE_URL: '',
                METRICS_ENABLED: 'false',
            });
        } else {
            const auth = await demoAuth(directory);
            runChild(app, ['start:dev', '--dev-client', '--localhost', '--port', String(config.expoPort)], {
                ...base,
                NODE_ENV: 'development',
                HAPPY_DEMO_MODE: '1',
                EXPO_PUBLIC_DEMO_MODE: '1',
                EXPO_PUBLIC_SERVER_URL: serverUrl,
                EXPO_PUBLIC_HAPPY_SERVER_URL: serverUrl,
                EXPO_PUBLIC_DISABLE_ANALYTICS: '1',
                EXPO_NO_TELEMETRY: '1',
                EXPO_OFFLINE: '1',
                BROWSER: 'none',
                EXPO_PUBLIC_DEMO_DEV_TOKEN: auth.token,
                EXPO_PUBLIC_DEMO_DEV_SECRET: auth.secret,
                NODE_OPTIONS: '--dns-result-order=ipv4first',
            });
        }
    } else if (command === 'status') {
        console.log(JSON.stringify({
            name: config.name,
            serverUrl,
            metroUrl: `http://127.0.0.1:${config.expoPort}`,
        }));
    } else {
        throw new Error('Use new, seed, server, metro, or status.');
    }
}