import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createServer } from 'node:http';
import environmentHelpers from '../../../../../environments/environments.ts';
import { configFromEnv, createGateway } from '../../../../../integrations/rakazo/gateway/server.mjs';

// Real Paws auth/server/App + real pinned Rakazo API/worker/GPT. No agent stubs.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const output = path.join(root, 'packages/happy-app/test-results/bots-rakazo');
const { createEnvironment, getEnvironmentConfig, setEnvironmentTemplate, startEnvironmentServices,
    seedEnvironment, startEnvironmentWeb, stopEnvironment } = environmentHelpers;
const gatewayFile = process.env.PAWS_BOTS_QA_GATEWAY_ENV;
if (!gatewayFile) throw new Error('Provide the private runtime gateway.env using PAWS_BOTS_QA_GATEWAY_ENV');
const privateEnv = parseEnv(await fs.readFile(gatewayFile, 'utf8'));
delete process.env.TSX_TSCONFIG_PATH;
process.env.HAPPY_E2E_DISABLE_WATCHMAN = '1';
process.env.S3_HOST = '';
process.env.NO_PROXY = [process.env.NO_PROXY, 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',');
const log = console.log;
console.log = (...args) => log(...args.map(value => typeof value === 'string' && value.includes('Auth URL:') ? 'Auth URL: saved privately' : value));
await fs.mkdir(output, { recursive: true });
let environment, gateway, controller;
async function shutdown() {
    if (environment) stopEnvironment(environment);
    gateway?.closeAllConnections(); gateway?.close();
    controller?.closeAllConnections(); controller?.close();
}
async function main() {
    const reuse = process.env.PAWS_BOTS_QA_REUSE_ENV;
    environment = reuse || await createEnvironment({ noSwitch: true });
    setEnvironmentTemplate(environment, 'authenticated-empty');
    const config = getEnvironmentConfig(environment);
    const webUrl = `http://localhost:${config.expoPort}`;
    const serverUrl = `http://localhost:${config.serverPort}`;
    const envDirectory = path.join(root, 'environments/data/envs', environment);
    await fs.chmod(envDirectory, 0o700);
    const runtimeOrigin = 'http://127.0.0.1:3490';
    const parentOrigins = `${webUrl},http://127.0.0.1:${config.expoPort},${serverUrl}`;
    gateway = createGateway(configFromEnv({ ...privateEnv, PAWS_BOTS_PUBLIC_ORIGIN: runtimeOrigin, PAWS_BOTS_ALLOWED_PARENT_ORIGINS: parentOrigins })).server;
    await new Promise((resolve, reject) => { gateway.once('error', reject); gateway.listen(3490, '127.0.0.1', resolve); });
    process.env.PAWS_BOTS_GATEWAY_BOOTSTRAP_URL = runtimeOrigin + '/__paws/bootstrap';
    process.env.PAWS_BOTS_BRIDGE_SECRET = privateEnv.PAWS_BOTS_BRIDGE_SECRET;
    process.env.PAWS_BOTS_ALLOWED_PARENT_ORIGINS = parentOrigins;
    await startEnvironmentServices(environment, { startWeb: false, waitForWebBundle: true });
    delete process.env.PAWS_BOTS_BRIDGE_SECRET;
    delete process.env.PAWS_BOTS_GATEWAY_BOOTSTRAP_URL;
    delete process.env.PAWS_BOTS_ALLOWED_PARENT_ORIGINS;
    const accounts = [];
    for (const label of ['one', 'two']) {
        const authUrlFile = path.join(output, `auth-${label}.txt`);
        const credentialsFile = path.join(output, `credentials-${label}.json`);
        if (!reuse) {
            await seedEnvironment(environment, { startDaemon: false });
            await fs.chmod(path.join(envDirectory, 'cli/home/access.key'), 0o600);
            await fs.writeFile(authUrlFile, getEnvironmentConfig(environment).authenticatedWebUrl, { mode: 0o600 });
            await fs.copyFile(path.join(envDirectory, 'cli/home/access.key'), credentialsFile);
            await fs.chmod(credentialsFile, 0o600);
        } else {
            await fs.access(authUrlFile); await fs.access(credentialsFile);
        }
        accounts.push({ label, authUrlFile, credentialsFile });
    }
    await fs.chmod(path.join(envDirectory, 'config.json'), 0o600).catch(() => {});
    const runtime = { environment, pid: process.pid, webUrl, serverUrl, runtimeOrigin, accounts,
        boundaries: { app: 'full Paws App', server: 'isolated PGlite and synthetic accounts',
            bots: 'pinned native Rakazo Web/API/worker/PostgreSQL', model: 'real local GPT gateway',
            sandboxProvider: 'none', productionDeployment: false } };
    controller = createServer((request, response) => {
        response.setHeader('Content-Type', 'application/json');
        if (request.method === 'GET' && request.url === '/runtime') return response.end(JSON.stringify(runtime));
        if (request.method === 'POST' && request.url === '/shutdown') {
            response.end('{"stopped":true}'); void shutdown(); return;
        }
        response.writeHead(404); response.end('{}');
    });
    await new Promise(resolve => controller.listen(0, '127.0.0.1', resolve));
    runtime.controllerUrl = `http://127.0.0.1:${controller.address().port}`;
    await fs.writeFile(path.join(output, 'runtime.json'), JSON.stringify(runtime, null, 2), { mode: 0o600 });
    await startEnvironmentWeb(environment, { warmBundle: true, queryAuthOnly: true });
    await import('../goal-board/repair-router-types.mjs');
    log(JSON.stringify({ ready: true, webUrl, serverUrl, controllerUrl: runtime.controllerUrl, runtimeFile: path.join(output, 'runtime.json') }));
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
main().catch(async () => { log('Bots fixture failed; inspect private environment logs.'); await shutdown(); process.exitCode = 1; });
