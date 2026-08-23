import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    createEnvironment,
    getEnvironmentConfig,
    seedEnvironment,
    setEnvironmentTemplate,
    startEnvironmentServices,
    startEnvironmentWeb,
    stopEnvironment,
} from '../environments/environments';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const armHomebrewBin = '/opt/homebrew/bin';

if (process.platform === 'darwin' && process.arch === 'arm64' && fs.existsSync(armHomebrewBin)) {
    process.env.PATH = `${process.env.PATH ?? ''}:${armHomebrewBin}`;
}

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): void {
    const result = spawnSync(command, args, {
        cwd: repoRoot,
        env: { ...process.env, ...env },
        stdio: 'inherit',
    });

    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} 执行失败，退出码 ${result.status ?? 'unknown'}`);
    }
}

function prepareMp4Fixture(): { filePath: string; temporaryDirectory: string | null } {
    const provided = process.env.HAPPY_E2E_MP4_PATH;
    if (provided) {
        const filePath = path.resolve(provided);
        if (!fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
            throw new Error(`HAPPY_E2E_MP4_PATH 不是可读文件：${filePath}`);
        }
        return { filePath, temporaryDirectory: null };
    }

    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'paws-chat-mp4-e2e-'));
    const filePath = path.join(temporaryDirectory, 'chat-mp4-fixture.mp4');
    run('ffmpeg', [
        '-y',
        '-f', 'lavfi',
        '-i', 'testsrc2=s=640x360:r=25',
        '-t', '4',
        '-an',
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        filePath,
    ]);
    return { filePath, temporaryDirectory };
}

async function main(): Promise<void> {
    let environmentName: string | null = null;
    let temporaryVideoDirectory: string | null = null;
    const playwrightArgs = process.argv.slice(2).filter((arg) => arg !== '--');

    try {
        environmentName = await createEnvironment({ noSwitch: true });
        setEnvironmentTemplate(environmentName, 'authenticated-empty');

        const builtCliEntry = path.join(repoRoot, 'packages', 'happy-cli', 'dist', 'index.mjs');
        const reuseBuiltCli = process.env.HAPPY_E2E_SKIP_CLI_BUILD === '1'
            && fs.statSync(builtCliEntry, { throwIfNoEntry: false })?.isFile();
        if (reuseBuiltCli) {
            console.log('复用当前 worktree 已构建的本地测试 CLI。');
        } else {
            console.log('构建本地测试 CLI...');
            run('pnpm', ['--filter', '@wangjs-jacky/paws', 'build']);
        }

        const videoFixture = prepareMp4Fixture();
        temporaryVideoDirectory = videoFixture.temporaryDirectory;

        // Keep the server out of the expensive CLI build window. On loaded
        // development machines it can otherwise exit before seeding starts.
        await startEnvironmentServices(environmentName, {
            startWeb: false,
            waitForWebBundle: true,
        });

        const originalConsoleLog = console.log;
        console.log = (...values: unknown[]) => {
            if (String(values[0] ?? '').includes('Auth URL:')) {
                originalConsoleLog('  Auth URL: 已生成（凭证已隐藏）');
                return;
            }
            originalConsoleLog(...values);
        };
        try {
            await seedEnvironment(environmentName, { startDaemon: false });
        } finally {
            console.log = originalConsoleLog;
        }
        await startEnvironmentWeb(environmentName, { warmBundle: true });

        const config = getEnvironmentConfig(environmentName);
        if (!config.authenticatedWebUrl) {
            throw new Error('测试环境没有生成认证 Web URL。');
        }

        run(
            'pnpm',
            ['--filter', 'happy-app', 'exec', 'playwright', 'test', ...playwrightArgs],
            {
                HAPPY_E2E_SERVER_URL: `http://localhost:${config.serverPort}`,
                HAPPY_E2E_WEB_URL: config.authenticatedWebUrl,
                HAPPY_E2E_MP4_PATH: videoFixture.filePath,
            },
        );
    } catch (error) {
        if (environmentName) {
            for (const service of ['server', 'web']) {
                const logPath = path.join(
                    repoRoot,
                    'environments',
                    'data',
                    'envs',
                    environmentName,
                    service,
                    'stdout.log',
                );
                if (fs.existsSync(logPath)) {
                    console.error(`\n${service === 'server' ? 'Server' : 'Web'} 服务日志：\n`);
                    console.error(fs.readFileSync(logPath, 'utf8'));
                }
            }
        }
        throw error;
    } finally {
        if (environmentName) {
            stopEnvironment(environmentName);
            run('pnpm', ['exec', 'tsx', 'environments/environments.ts', 'remove', environmentName]);
        }
        if (temporaryVideoDirectory) {
            fs.rmSync(temporaryVideoDirectory, { recursive: true, force: true });
        }
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
