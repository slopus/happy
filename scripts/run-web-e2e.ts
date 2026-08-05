import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    createEnvironment,
    getEnvironmentConfig,
    seedEnvironment,
    setEnvironmentTemplate,
    startEnvironmentServices,
    stopEnvironment,
} from '../environments/environments';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const armHomebrewBin = '/opt/homebrew/bin';

if (process.platform === 'darwin' && process.arch === 'arm64' && fs.existsSync(armHomebrewBin)) {
    process.env.PATH = `${armHomebrewBin}:${process.env.PATH ?? ''}`;
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

async function main(): Promise<void> {
    let environmentName: string | null = null;
    const playwrightArgs = process.argv.slice(2).filter((arg) => arg !== '--');

    try {
        environmentName = await createEnvironment({ noSwitch: true });
        setEnvironmentTemplate(environmentName, 'authenticated-empty');
        await startEnvironmentServices(environmentName);

        console.log('构建本地测试 CLI...');
        run('pnpm', ['--filter', '@wangjs-jacky/paws', 'build']);

        const originalConsoleLog = console.log;
        console.log = (...values: unknown[]) => {
            if (String(values[0] ?? '').includes('Auth URL:')) {
                originalConsoleLog('  Auth URL: 已生成（凭证已隐藏）');
                return;
            }
            originalConsoleLog(...values);
        };
        try {
            await seedEnvironment(environmentName);
        } finally {
            console.log = originalConsoleLog;
        }

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
            },
        );
    } catch (error) {
        if (environmentName) {
            const webLogPath = path.join(
                repoRoot,
                'environments',
                'data',
                'envs',
                environmentName,
                'web',
                'stdout.log',
            );
            if (fs.existsSync(webLogPath)) {
                console.error('\nWeb 服务日志：\n');
                console.error(fs.readFileSync(webLogPath, 'utf8'));
            }
        }
        throw error;
    } finally {
        if (environmentName) {
            stopEnvironment(environmentName);
            run('pnpm', ['exec', 'tsx', 'environments/environments.ts', 'remove', environmentName]);
        }
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
