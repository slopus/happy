import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keyPath = path.resolve(
    process.env.HAPPY_E2E_PRODUCTION_KEY_PATH
        ?? path.join(repoRoot, '.paws-e2e-production.key'),
);
const authStatePath = path.join(
    repoRoot,
    'packages/happy-app/test-results/.auth/production.json',
);
const productionResultDir = path.join(
    repoRoot,
    'packages/happy-app/test-results/production-session',
);
const deliveryDir = path.join(
    repoRoot,
    'packages/happy-app/test-results/production-session-delivery',
);
let webProcess: ChildProcess | null = null;

function assertPreconditions(): void {
    if (process.env.HAPPY_E2E_PRODUCTION !== '1') {
        throw new Error(
            '该命令会向生产账号创建真实 Session；请显式设置 HAPPY_E2E_PRODUCTION=1。',
        );
    }
    if (!fs.existsSync(keyPath) || !fs.statSync(keyPath).isFile()) {
        throw new Error('找不到可读取的 .paws-e2e-production.key。');
    }
    if (process.platform === 'darwin' && process.arch !== 'arm64') {
        throw new Error(`当前 Node 架构为 ${process.arch}，生产回归要求 macOS ARM64 原生运行。`);
    }
}

async function findAvailablePort(): Promise<number> {
    const requestedPort = process.env.HAPPY_E2E_PORT;
    if (requestedPort) return Number.parseInt(requestedPort, 10);

    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port: 0 }, () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                server.close();
                reject(new Error('无法分配本地 Web 端口。'));
                return;
            }
            const { port } = address;
            server.close((error) => error ? reject(error) : resolve(port));
        });
    });
}

async function waitForWeb(url: string, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(url);
            if (response.ok) {
                const html = await response.text();
                const bundlePath = html.match(/<script[^>]+src="([^"]+\.bundle\?[^"]+)"/)?.[1];
                if (!bundlePath) {
                    throw new Error('首页中找不到 Web bundle。');
                }
                const remainingMs = Math.max(1, deadline - Date.now());
                const bundleResponse = await fetch(new URL(bundlePath, url), {
                    signal: AbortSignal.timeout(remainingMs),
                });
                if (bundleResponse.ok) {
                    await bundleResponse.arrayBuffer();
                    return;
                }
            }
        } catch {
            // Metro 仍在启动。
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(`本地 Web 服务在 ${timeoutMs}ms 内未就绪。`);
}

function stopWebProcess(): void {
    if (!webProcess?.pid || webProcess.killed) return;
    try {
        if (process.platform === 'win32') {
            webProcess.kill('SIGTERM');
        } else {
            process.kill(-webProcess.pid, 'SIGTERM');
        }
    } catch {
        webProcess.kill('SIGTERM');
    }
}

function findGeneratedFiles(directory: string, predicate: (file: string) => boolean): string[] {
    if (!fs.existsSync(directory)) return [];
    const files: string[] = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...findGeneratedFiles(entryPath, predicate));
        } else if (entry.isFile() && predicate(entryPath)) {
            files.push(entryPath);
        }
    }
    return files;
}

function createRecordedDelivery(): void {
    const videos = findGeneratedFiles(productionResultDir, (file) => file.endsWith('.webm'))
        .sort((left, right) => fs.statSync(right).size - fs.statSync(left).size);
    if (videos.length === 0) {
        throw new Error('生产回归已通过，但没有生成预期的脱敏录屏。');
    }

    fs.rmSync(deliveryDir, { recursive: true, force: true });
    fs.mkdirSync(deliveryDir, { recursive: true });

    const videoPath = path.join(deliveryDir, 'paws-production-session-e2e.webm');
    fs.copyFileSync(videos[0], videoPath);

    const screenshotSources = findGeneratedFiles(
        productionResultDir,
        (file) => /-pc-(?:narrow|wide)\.png$/.test(file),
    );
    const latestScreenshotByViewport = new Map<string, string>();
    for (const source of screenshotSources) {
        const viewport = source.endsWith('-pc-narrow.png') ? 'pc-narrow' : 'pc-wide';
        latestScreenshotByViewport.set(viewport, source);
    }
    const screenshotPaths: Record<string, string> = {};
    for (const [viewport, source] of latestScreenshotByViewport) {
        const destination = path.join(deliveryDir, `${viewport}.png`);
        fs.copyFileSync(source, destination);
        screenshotPaths[viewport] = destination;
    }

    const traceSource = findGeneratedFiles(
        productionResultDir,
        (file) => path.basename(file) === 'safe-trace.json' && !file.includes('/attachments/'),
    )[0];
    const diagnosticsSource = findGeneratedFiles(
        productionResultDir,
        (file) => path.basename(file) === 'safe-diagnostics.json' && !file.includes('/attachments/'),
    )[0];
    if (!traceSource || !diagnosticsSource) {
        throw new Error('生产回归已通过，但缺少脱敏时间线或诊断记录。');
    }

    const tracePath = path.join(deliveryDir, 'safe-trace.json');
    const diagnosticsPath = path.join(deliveryDir, 'safe-diagnostics.json');
    fs.copyFileSync(traceSource, tracePath);
    fs.copyFileSync(diagnosticsSource, diagnosticsPath);

    const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8')) as Array<{
        step?: string;
        data?: { navigationMs?: number };
    }>;
    const navigationTimes = trace
        .filter((event) => event.step === 'new-session-navigated')
        .map((event) => event.data?.navigationMs)
        .filter((value): value is number => typeof value === 'number');
    const navigationSummary = navigationTimes.length > 0
        ? navigationTimes.map((value) => `${(value / 1_000).toFixed(1)} 秒`).join('、')
        : '未记录';

    const reportPath = path.join(deliveryDir, 'E2E-视频报告.md');
    const report = `# Paws 真实 Mac mini / Codex E2E 视频报告

> 结果：通过。录屏不包含登录与密钥输入；生产账号侧栏已遮挡，文件明细与非目标设备/Agent 已模糊。

## 回归入口

- 完整录屏：[paws-production-session-e2e.webm](${videoPath})
- 窄屏截图：[1470×863](${screenshotPaths['pc-narrow'] ?? '未生成'})
- 宽屏截图：[2552×1396](${screenshotPaths['pc-wide'] ?? '未生成'})
- 脱敏时间线：[safe-trace.json](${tracePath})
- 脱敏诊断：[safe-diagnostics.json](${diagnosticsPath})

## 视频中的真实链路

1. 从 localhost 待测前端进入“新建会话”。
2. 选择在线的真实 \`mac-mini\`，再选择 \`codex\`。
3. 输入“你好，只回复：链路已打通 <唯一运行标识>”，按 Enter 创建真实 Session。
4. 等待新的用户消息和 Codex 回复；旧消息不能作为通过证据。
5. 在右侧真实文件面板开启时，分别切换到 \`1470×863\` 与 \`2552×1396\`，验证头部按钮命中区域不重叠。
6. 刷新同一 Session，确认首轮消息仍存在，再完成第二次唯一消息往返。

## 自动验收结果

- 新 Session 导航完成，耗时：${navigationSummary}；预算上限为 60 秒。
- Enter 没有插入换行，输入框提交后清空。
- 首轮和刷新后的第二轮均收到包含“链路已打通”和唯一运行标识的新回复。
- 两组 PC 视口的导航按钮与会话 Chip 可见区域、hitSlop 和 4px 安全间距断言通过。
- 真实右侧文件面板可见且宽度大于 200px。
- 控制台 error 为 0；意外 HTTP 4xx/5xx 为 0。
- 临时生产登录态已在测试结束时删除。

## 用户最短验收动作

观看完整录屏，确认设备与 Agent 选择、两轮真实回复，以及窄屏/宽屏头部按钮没有挤压或重叠。若视觉体验符合预期，即可把任务从 \`waitingHuman\` 标记为 \`done\`。
`;
    fs.writeFileSync(reportPath, report, 'utf8');
    process.stdout.write(`脱敏录屏：${videoPath}\n`);
    process.stdout.write(`视频报告：${reportPath}\n`);
}

async function main(): Promise<void> {
    assertPreconditions();
    const port = await findAvailablePort();
    const webUrl = `http://127.0.0.1:${port}`;

    process.once('SIGINT', () => {
        stopWebProcess();
        process.exitCode = 130;
    });
    process.once('SIGTERM', () => {
        stopWebProcess();
        process.exitCode = 143;
    });

    webProcess = spawn(
        'pnpm',
        ['--filter', 'happy-app', 'exec', 'expo', 'start', '--web', '--port', String(port)],
        {
            cwd: repoRoot,
            detached: process.platform !== 'win32',
            stdio: 'inherit',
            env: {
                ...process.env,
                CI: '1',
                HAPPY_E2E_DISABLE_WATCHMAN: '1',
                EXPO_PUBLIC_HAPPY_SERVER_URL: 'https://47.115.228.20:8443',
                EXPO_PUBLIC_DISABLE_ANALYTICS: '1',
            },
        },
    );

    try {
        await waitForWeb(webUrl);
        const result = spawnSync(
            'pnpm',
            [
                '--filter',
                'happy-app',
                'exec',
                'playwright',
                'test',
                '--config',
                'playwright.production.config.ts',
            ],
            {
                cwd: repoRoot,
                stdio: 'inherit',
                env: {
                    ...process.env,
                    HAPPY_E2E_PRODUCTION_WEB_URL: webUrl,
                    HAPPY_E2E_PRODUCTION_KEY_PATH: keyPath,
                },
            },
        );
        if (result.status !== 0) {
            throw new Error(`生产 Session 回归失败，退出码 ${result.status ?? 'unknown'}。`);
        }
        if (process.env.HAPPY_E2E_RECORD === '1') {
            createRecordedDelivery();
        }
    } finally {
        stopWebProcess();
        // storageState 含生产 token/secret，只用于 Playwright 项目之间的临时交接，
        // 绝不能作为测试证据长期保留。
        fs.rmSync(authStatePath, { force: true });
        try {
            fs.rmdirSync(path.dirname(authStatePath));
        } catch {
            // 目录内可能存在另一个并发任务的文件，因此保留目录本身。
        }
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
