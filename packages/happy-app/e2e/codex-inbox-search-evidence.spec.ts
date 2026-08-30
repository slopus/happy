import { expect, test, type APIRequestContext, type TestInfo } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { io } from 'socket.io-client';

import { decodeBase64, decryptLegacy, encodeBase64, encryptLegacy } from '../../happy-cli/src/api/encryption';

const authenticatedWebUrl = process.env.HAPPY_E2E_WEB_URL!;
const e2eServerUrl = process.env.HAPPY_E2E_SERVER_URL!;
const evidenceDirectory = process.env.HAPPY_CODEX_INBOX_EVIDENCE_DIR;
const evidencePhase = process.env.HAPPY_CODEX_INBOX_EVIDENCE_PHASE === 'before' ? 'before' : 'after';

type Candidate = {
    threadId: string;
    title: string;
    directory: string;
    createdAt: number;
    updatedAt: number;
};

function authenticatedRoute(pathname: string): string {
    const url = new URL(authenticatedWebUrl);
    url.pathname = pathname;
    return url.toString();
}

function screenshotPath(testInfo: TestInfo): string {
    const filename = `case-1-${evidencePhase}.png`;
    if (!evidenceDirectory) return testInfo.outputPath(filename);
    fs.mkdirSync(evidenceDirectory, { recursive: true });
    return path.join(evidenceDirectory, filename);
}

async function createAttachedSession(
    request: APIRequestContext,
    token: string,
    encryptionKey: Uint8Array,
    machineId: string,
    candidate: Candidate,
): Promise<string> {
    const metadata = encodeBase64(encryptLegacy({
        path: candidate.directory,
        host: 'studio-mac-mini',
        name: candidate.title,
        flavor: 'codex',
        machineId,
        codexThreadId: candidate.threadId,
        lifecycleState: 'running',
        startedBy: 'terminal',
    }, encryptionKey));
    const response = await request.post(new URL('/v1/sessions', e2eServerUrl).toString(), {
        data: {
            tag: `codex-inbox-e2e-${candidate.threadId}`,
            metadata,
            agentState: null,
            dataEncryptionKey: null,
        },
        headers: {
            Authorization: `Bearer ${token}`,
            'X-Happy-Client': 'playwright-codex-inbox-e2e',
        },
    });
    expect(response.ok()).toBe(true);
    const body = await response.json() as { session: { id: string } };
    return body.session.id;
}

async function createCandidateMachine(request: APIRequestContext): Promise<{
    candidates: Candidate[];
    close: () => Promise<void>;
}> {
    const authUrl = new URL(authenticatedWebUrl);
    const token = authUrl.searchParams.get('dev_token');
    const secret = authUrl.searchParams.get('dev_secret');
    if (!token || !secret || !e2eServerUrl) {
        throw new Error('缺少 Codex 收件箱 E2E 所需的本地认证配置。');
    }

    const encryptionKey = new Uint8Array(Buffer.from(secret, 'base64url'));
    const machineId = `codex-inbox-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    const candidates: Candidate[] = [
        {
            threadId: 'codex-inbox-search-thread',
            title: '实现 Codex 会话接管搜索',
            directory: '/Users/jacky/jacky-github/happy',
            createdAt: now - 90_000,
            updatedAt: now - 15_000,
        },
        {
            threadId: 'codex-inbox-photo-wall-thread',
            title: '调研图片墙开源方案',
            directory: '/Users/jacky/Documents/照片墙',
            createdAt: now - 180_000,
            updatedAt: now - 60_000,
        },
        {
            threadId: 'codex-inbox-browser-thread',
            title: '修复远端浏览器连接',
            directory: '/Users/jacky/Documents/济州岛',
            createdAt: now - 240_000,
            updatedAt: now - 120_000,
        },
    ];
    const hiddenThreadIds = new Set<string>();
    const headers = {
        Authorization: `Bearer ${token}`,
        'X-Happy-Client': 'playwright-codex-inbox-e2e',
    };
    const machineMetadata = encodeBase64(encryptLegacy({
        host: 'studio-mac-mini',
        platform: 'darwin',
        happyCliVersion: '0.0.0-e2e',
        happyHomeDir: '/tmp/.happy',
        homeDir: '/Users/jacky',
        cliAvailability: {
            ask: true,
            claude: true,
            codex: true,
            gemini: true,
            opencode: true,
            openclaw: true,
            detectedAt: now,
        },
    }, encryptionKey));
    const registerResponse = await request.post(new URL('/v1/machines', e2eServerUrl).toString(), {
        data: { id: machineId, metadata: machineMetadata, dataEncryptionKey: null },
        headers,
    });
    expect(registerResponse.ok()).toBe(true);

    const socket = io(e2eServerUrl, {
        auth: {
            token,
            clientType: 'machine-scoped',
            machineId,
            happyClient: 'playwright-codex-inbox-rpc',
        },
        autoConnect: false,
        path: '/v1/updates',
        reconnection: false,
        transports: ['websocket'],
    });
    socket.on('rpc-request', (
        data: { method: string; params: string },
        callback: (response: string) => void,
    ) => {
        void (async () => {
            const params = decryptLegacy(decodeBase64(data.params), encryptionKey) as {
                threadId?: string;
            } | null;
            let result: unknown;
            if (data.method === `${machineId}:codex-list-attach-candidates`) {
                result = { candidates: candidates.filter((candidate) => !hiddenThreadIds.has(candidate.threadId)) };
            } else if (data.method === `${machineId}:codex-dismiss-attach-candidate` && params?.threadId) {
                hiddenThreadIds.add(params.threadId);
                result = { type: 'success' };
            } else if (data.method === `${machineId}:codex-attach-candidate` && params?.threadId) {
                const candidate = candidates.find((item) => item.threadId === params.threadId);
                if (!candidate) throw new Error('找不到待接管的测试会话。');
                hiddenThreadIds.add(candidate.threadId);
                const sessionId = await createAttachedSession(request, token, encryptionKey, machineId, candidate);
                result = { type: 'success', sessionId };
            } else {
                result = { type: 'error', error: 'Unknown Codex inbox E2E RPC request.' };
            }
            callback(encodeBase64(encryptLegacy(result, encryptionKey)));
        })().catch((error) => {
            callback(encodeBase64(encryptLegacy({
                type: 'error',
                error: error instanceof Error ? error.message : String(error),
            }, encryptionKey)));
        });
    });

    const methods = new Set([
        `${machineId}:codex-list-attach-candidates`,
        `${machineId}:codex-dismiss-attach-candidate`,
        `${machineId}:codex-attach-candidate`,
    ]);
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Codex 收件箱 E2E RPC 注册超时。')), 10_000);
        const handleConnectError = (error: Error) => {
            clearTimeout(timeout);
            reject(error);
        };
        const handleRegistered = ({ method }: { method: string }) => {
            methods.delete(method);
            if (methods.size > 0) return;
            clearTimeout(timeout);
            socket.off('connect_error', handleConnectError);
            socket.off('rpc-registered', handleRegistered);
            socket.emit('machine-alive', { machineId, time: Date.now() });
            resolve();
        };
        socket.once('connect_error', handleConnectError);
        socket.on('rpc-registered', handleRegistered);
        socket.once('connect', () => {
            for (const method of methods) socket.emit('rpc-register', { method });
        });
        socket.connect();
    });
    const keepAlive = setInterval(() => {
        socket.emit('machine-alive', { machineId, time: Date.now() });
    }, 500);

    return {
        candidates,
        close: async () => {
            clearInterval(keepAlive);
            socket.close();
            const response = await request.delete(
                new URL(`/v1/machines/${encodeURIComponent(machineId)}`, e2eServerUrl).toString(),
                { headers },
            );
            expect(response.ok() || response.status() === 404).toBe(true);
        },
    };
}

test.describe('Codex 待接管会话搜索', () => {
    test.use({ locale: 'zh-CN' });

    test('[CODEX-SEARCH-1] 单列表搜索并在接管后隐藏会话', async ({ page, request }, testInfo) => {
        test.setTimeout(180_000);
        await page.setViewportSize({ width: 1280, height: 900 });
        const machine = await createCandidateMachine(request);
        try {
            await page.goto(authenticatedRoute('/inbox'));
            for (const candidate of machine.candidates) {
                await expect(page.getByText(candidate.title, { exact: true })).toBeVisible({ timeout: 120_000 });
            }

            const searchInput = page.getByRole('textbox', {
                name: '搜索标题、项目路径或电脑',
                exact: true,
            });
            if (evidencePhase === 'before') {
                await expect(searchInput).toHaveCount(0);
            } else {
                await expect(searchInput).toBeVisible();
                await searchInput.fill('照片墙');
                await expect(page.getByText('调研图片墙开源方案', { exact: true })).toBeVisible();
                await expect(page.getByText('实现 Codex 会话接管搜索', { exact: true })).toHaveCount(0);
                await expect(page.getByText('修复远端浏览器连接', { exact: true })).toHaveCount(0);
            }

            await page.addStyleTag({
                content: '.__expo_fast_refresh { visibility: hidden !important; }',
            });
            await expect(page.locator('.__expo_fast_refresh_show')).toHaveCount(0, { timeout: 120_000 });
            await expect(page.locator('.__expo_fast_refresh')).toBeHidden();
            await page.screenshot({ path: screenshotPath(testInfo), fullPage: true });

            if (evidencePhase === 'after') {
                await searchInput.fill('实现 Codex');
                await page.getByRole('button', { name: '接管', exact: true }).click();
                await expect.poll(() => new URL(page.url()).pathname, { timeout: 30_000 }).toMatch(/^\/session\/[^/]+$/);
                await page.goto(authenticatedRoute('/inbox'));
                await expect(page.getByText('实现 Codex 会话接管搜索', { exact: true })).toHaveCount(0);
            }
        } finally {
            await machine.close();
            await page.close();
        }
    });
});
