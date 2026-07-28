import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node24Bin = '/Users/jiashengwang/.nvm/versions/node/v24.9.0/bin';
const armHomebrewBin = '/opt/homebrew/bin';
const port = Number.parseInt(process.env.HAPPY_E2E_PORT ?? '58921', 10);
const webUrl = `http://127.0.0.1:${port}`;
const secretKeyFile = path.resolve(
    process.env.HAPPY_E2E_SECRET_KEY_FILE ?? path.join(repoRoot, '.paws-e2e-production.key'),
);
const serverUrl = 'https://47.115.228.20:8443';
const appLogPath = path.join(repoRoot, 'test-results', 'production-restore-web.log');

function buildEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
        ...process.env,
        ...extra,
        PATH: `${node24Bin}:${armHomebrewBin}:/usr/bin:/bin`,
    };
}

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): void {
    const result = spawnSync(command, args, {
        cwd: repoRoot,
        env: buildEnvironment(env),
        stdio: 'inherit',
        timeout: 360_000,
        killSignal: 'SIGTERM',
    });
    if (result.status !== 0) {
        const reason = result.signal
            ? `信号 ${result.signal}`
            : `退出码 ${result.status ?? 'unknown'}`;
        throw new Error(`${command} ${args.join(' ')} 执行失败，${reason}`);
    }
}

async function assertPortAvailable(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const server = net.createServer();
        server.once('error', () => reject(new Error(`端口 ${port} 已被占用，请通过 HAPPY_E2E_PORT 指定独立端口。`)));
        server.once('listening', () => server.close(() => resolve()));
        server.listen(port, '127.0.0.1');
    });
}

function validateSecretFile(): void {
    const realPath = fs.realpathSync(secretKeyFile);
    const mode = fs.statSync(realPath).mode & 0o777;
    if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
        throw new Error('生产 E2E 密钥文件权限过宽，必须仅允许当前用户读取。');
    }

    const ignored = spawnSync('git', ['check-ignore', '--quiet', secretKeyFile], {
        cwd: repoRoot,
        env: buildEnvironment(),
    });
    if (ignored.status !== 0) {
        throw new Error('生产 E2E 密钥文件未被 Git 忽略，拒绝启动。');
    }
}

async function waitForWeb(processHandle: ChildProcess): Promise<void> {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
        if (processHandle.exitCode !== null) {
            throw new Error(`Web 服务提前退出，退出码 ${processHandle.exitCode}`);
        }
        try {
            const response = await fetch(webUrl);
            if (response.ok) return;
        } catch {
            // Metro 仍在构建，继续轮询。
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('等待 localhost Web 服务超时。');
}

async function stopProcess(processHandle: ChildProcess): Promise<void> {
    if (processHandle.exitCode !== null) return;
    processHandle.kill('SIGTERM');
    await Promise.race([
        new Promise<void>((resolve) => processHandle.once('exit', () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (processHandle.exitCode === null) {
        processHandle.kill('SIGKILL');
    }
}

async function main(): Promise<void> {
    validateSecretFile();
    await assertPortAvailable();
    run('pnpm', ['--filter', '@slopus/happy-wire', 'build']);
    fs.mkdirSync(path.dirname(appLogPath), { recursive: true });
    const appLog = fs.openSync(appLogPath, 'w');
    const webProcess = spawn(
        'pnpm',
        ['--filter', 'happy-app', 'exec', 'expo', 'start', '--web', '--port', String(port), '--clear'],
        {
            cwd: repoRoot,
            env: buildEnvironment({
                CI: '1',
                EXPO_PUBLIC_HAPPY_SERVER_URL: serverUrl,
            }),
            stdio: ['ignore', appLog, appLog],
        },
    );

    try {
        await waitForWeb(webProcess);
        run(
            'pnpm',
            ['--filter', 'happy-app', 'exec', 'playwright', 'test', 'e2e/production-restore.spec.ts'],
            {
                HAPPY_E2E_PRODUCTION: '1',
                HAPPY_E2E_SECRET_KEY_FILE: secretKeyFile,
                HAPPY_E2E_WEB_URL: webUrl,
            },
        );
    } catch (error) {
        console.error(`Web 服务日志：${appLogPath}`);
        throw error;
    } finally {
        await stopProcess(webProcess);
        fs.closeSync(appLog);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
