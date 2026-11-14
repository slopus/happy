#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, stat, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = path.dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(await readFile(path.join(source, 'upstream.lock.json'), 'utf8'));
const args = process.argv.slice(2);
const action = args.shift();
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const directory = option('--directory') || process.env.PAWS_BOTS_HOME;
if (!['prepare', 'start', 'stop', 'status'].includes(action) || !directory || !path.isAbsolute(directory)) {
    process.stderr.write('Usage: node stack.mjs prepare|start|stop|status --directory <absolute-private-data-directory> [--model <local-model-id>] [--model-url <operator-controlled-url>]\n');
    process.exit(2);
}
const envPath = path.join(directory, '.env');
const composePath = path.join(directory, 'compose.core.yml');
const secret = () => randomBytes(32).toString('hex');
const port = (name, fallback) => {
    const value = Number(option(name) || fallback);
    if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`Invalid ${name}`);
    return value;
};
const parseEnv = text => Object.fromEntries(text.split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => {
    const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)];
}));
const run = (binary, values) => new Promise((resolve, reject) => {
    const child = spawn(binary, values, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${binary} exited ${code ?? signal}`)));
});

try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (action === 'prepare' || action === 'start') {
        try { await stat(envPath); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            const webPort = port('--web-port', 15730), apiPort = port('--api-port', 15731);
            const model = option('--model') || 'codex/gpt-6.1-sol';
            const modelUrl = new URL(option('--model-url') || 'http://host.docker.internal:3425/v1');
            if (modelUrl.username || modelUrl.password || modelUrl.search || modelUrl.hash) throw new Error('The model URL must not contain credentials, a query or a fragment');
            if (!['http:', 'https:'].includes(modelUrl.protocol)) throw new Error('The model URL requires HTTP or HTTPS');
            if (!model || /[\r\n,]/.test(model)) throw new Error('Use one model identifier');
            const values = {
                RAKAZO_APP_IMAGE: lock.appImage, RAKAZO_APP_TAG: lock.appTag, POSTGRES_IMAGE: lock.postgresImage,
                POSTGRES_PASSWORD: secret(), POSTGRES_APP_PASSWORD: secret(), BETTER_AUTH_SECRET: secret(),
                ENCRYPTION_KEY: secret(), SCREEN_PROXY_SECRET: secret(), RAKAZO_LOCAL_MODEL: model,
                RAKAZO_LOCAL_MODELS_URL: modelUrl.href.replace(/\/$/, ''), RAKAZO_LOCAL_MODELS_API_KEY: '',
                RAKAZO_WEB_PORT: String(webPort), RAKAZO_API_PORT: String(apiPort),
            };
            await writeFile(envPath, Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
        }
        await chmod(envPath, 0o600);
        await copyFile(path.join(source, 'compose.core.yml'), composePath);
    }
    const env = parseEnv(await readFile(envPath, 'utf8'));
    const compose = ['compose', '--project-name', 'paws-bots-rakazo', '--env-file', envPath, '-f', composePath];
    if (action === 'start') await run('docker', [...compose, 'up', '-d', '--wait', '--wait-timeout', '180']);
    if (action === 'stop') await run('docker', [...compose, 'down', '--timeout', '60', '--remove-orphans']);
    if (action === 'status') await run('docker', [...compose, 'ps']);
    const runtime = {
        upstreamCommit: lock.commit, appImage: env.RAKAZO_APP_IMAGE,
        nativeWebUrl: `http://127.0.0.1:${env.RAKAZO_WEB_PORT}`, nativeApiUrl: `http://127.0.0.1:${env.RAKAZO_API_PORT}`,
        model: env.RAKAZO_LOCAL_MODEL, sandboxProvider: 'none',
        credentialsFile: envPath,
    };
    await writeFile(path.join(directory, 'runtime.json'), JSON.stringify(runtime, null, 2), { mode: 0o600 });
    process.stdout.write(JSON.stringify({ action, ...runtime }) + '\n');
} catch (error) {
    process.stderr.write((error instanceof Error ? error.message : 'Rakazo stack operation failed') + '\n');
    process.exitCode = 1;
}
