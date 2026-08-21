import { expect, test, type APIRequestContext, type Locator, type Page, type Route, type TestInfo } from '@playwright/test';
import fs, { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { io } from 'socket.io-client';
import { decodeBase64, decryptBlob, decryptLegacy, encodeBase64, encryptLegacy } from '../../happy-cli/src/api/encryption';
import { deriveKey } from '../../happy-cli/src/utils/deriveKey';
import {
    expectProductionRedactionReady,
    installProductionRedaction,
} from '../e2e-production/productionRedaction';

const authenticatedWebUrl = process.env.HAPPY_E2E_WEB_URL!;
const e2eServerUrl = process.env.HAPPY_E2E_SERVER_URL!;
const standaloneToolEvidenceDirectory = process.env.HAPPY_STANDALONE_TOOL_EVIDENCE_DIR;
const standaloneToolEvidencePhase = process.env.HAPPY_STANDALONE_TOOL_EVIDENCE_PHASE ?? 'after';

function standaloneToolScreenshotPath(testInfo: TestInfo): string {
    const filename = `case-1-${standaloneToolEvidencePhase}.png`;
    if (!standaloneToolEvidenceDirectory) {
        return testInfo.outputPath(filename);
    }
    fs.mkdirSync(standaloneToolEvidenceDirectory, { recursive: true });
    return path.join(standaloneToolEvidenceDirectory, filename);
}

const projectHoverEvidenceDirectory = process.env.HAPPY_PROJECT_HOVER_EVIDENCE_DIR;
const projectHoverEvidencePhase = process.env.HAPPY_PROJECT_HOVER_EVIDENCE_PHASE ?? 'after';
const sessionStatusEvidenceDirectory = process.env.HAPPY_SESSION_STATUS_EVIDENCE_DIR;
const sessionStatusEvidencePhase = process.env.HAPPY_SESSION_STATUS_EVIDENCE_PHASE ?? 'after';
const titleTooltipEvidenceDirectory = process.env.HAPPY_TITLE_TOOLTIP_EVIDENCE_DIR;
const titleTooltipEvidencePhase = process.env.HAPPY_TITLE_TOOLTIP_EVIDENCE_PHASE ?? 'after';
const subagentInspectorEvidenceDirectory = process.env.HAPPY_SUBAGENT_INSPECTOR_EVIDENCE_DIR;
const messageHoverEvidenceDirectory = process.env.HAPPY_MESSAGE_HOVER_EVIDENCE_DIR;
const messageHoverEvidencePhase = process.env.HAPPY_MESSAGE_HOVER_EVIDENCE_PHASE ?? 'after';
const forkTranscriptEvidenceDirectory = process.env.HAPPY_FORK_TRANSCRIPT_EVIDENCE_DIR;
const motionPhotoEvidenceDirectory = process.env.HAPPY_MOTION_PHOTO_EVIDENCE_DIR;
const motionPhotoEvidencePhase = process.env.HAPPY_MOTION_PHOTO_EVIDENCE_PHASE === 'before' ? 'before' : 'after';

function projectHoverScreenshotPath(testInfo: { outputPath: (filename: string) => string }): string {
    const filename = `case-1-${projectHoverEvidencePhase}.png`;
    if (!projectHoverEvidenceDirectory) return testInfo.outputPath(filename);
    fs.mkdirSync(projectHoverEvidenceDirectory, { recursive: true });
    return path.join(projectHoverEvidenceDirectory, filename);
}

function sessionStatusScreenshotPath(
    testInfo: { outputPath: (filename: string) => string },
    caseId: 1 | 2,
): string {
    const filename = `case-${caseId}-${sessionStatusEvidencePhase}.png`;
    if (!sessionStatusEvidenceDirectory) return testInfo.outputPath(filename);
    fs.mkdirSync(sessionStatusEvidenceDirectory, { recursive: true });
    return path.join(sessionStatusEvidenceDirectory, filename);
}

function titleTooltipScreenshotPath(testInfo: { outputPath: (filename: string) => string }): string {
    const filename = `case-1-${titleTooltipEvidencePhase}.png`;
    if (!titleTooltipEvidenceDirectory) return testInfo.outputPath(filename);
    fs.mkdirSync(titleTooltipEvidenceDirectory, { recursive: true });
    return path.join(titleTooltipEvidenceDirectory, filename);
}

function subagentInspectorScreenshotPath(
    testInfo: { outputPath: (filename: string) => string },
    filename: string,
): string {
    if (!subagentInspectorEvidenceDirectory) return testInfo.outputPath(filename);
    fs.mkdirSync(subagentInspectorEvidenceDirectory, { recursive: true });
    return path.join(subagentInspectorEvidenceDirectory, filename);
}

function messageHoverScreenshotPath(
    testInfo: { outputPath: (filename: string) => string },
    caseId: 1 | 2 = 1,
): string {
    const filename = `case-${caseId}-${messageHoverEvidencePhase}.png`;
    if (!messageHoverEvidenceDirectory) return testInfo.outputPath(filename);
    fs.mkdirSync(messageHoverEvidenceDirectory, { recursive: true });
    return path.join(messageHoverEvidenceDirectory, filename);
}

function forkTranscriptScreenshotPath(
    testInfo: { outputPath: (filename: string) => string },
    phase: 'before' | 'after',
): string {
    const filename = `fork-transcript-${phase}.png`;
    if (!forkTranscriptEvidenceDirectory) return testInfo.outputPath(filename);
    fs.mkdirSync(forkTranscriptEvidenceDirectory, { recursive: true });
    return path.join(forkTranscriptEvidenceDirectory, filename);
}

function motionPhotoScreenshotPath(
    testInfo: { outputPath: (filename: string) => string },
    viewport: 'desktop' | 'mobile' = 'desktop',
): string {
    const viewportSuffix = viewport === 'mobile' ? '-mobile' : '';
    const filename = `motion-01${viewportSuffix}-${motionPhotoEvidencePhase}.png`;
    if (!motionPhotoEvidenceDirectory) return testInfo.outputPath(filename);
    fs.mkdirSync(motionPhotoEvidenceDirectory, { recursive: true });
    return path.join(motionPhotoEvidenceDirectory, filename);
}

function authenticatedRoute(pathname: string): string {
    const url = new URL(authenticatedWebUrl);
    url.pathname = pathname;
    return url.toString();
}

async function pauseForRecordedReview(page: Page, duration = 650): Promise<void> {
    // These pauses only pace human-review recordings; readiness remains covered
    // by the surrounding assertions, and normal CI runs do not wait here.
    if (process.env.HAPPY_E2E_RECORD === '1') {
        await page.waitForTimeout(duration);
    }
}

async function fulfillMp4Route(route: Route, fixture: Buffer): Promise<void> {
    const range = route.request().headers().range;
    const match = range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = match ? Number(match[1]) : 0;
    const requestedEnd = match?.[2] ? Number(match[2]) : fixture.length - 1;
    const end = Math.min(requestedEnd, fixture.length - 1);
    const body = fixture.subarray(start, end + 1);

    await route.fulfill({
        status: match ? 206 : 200,
        contentType: 'video/mp4',
        headers: {
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*',
            'Content-Length': String(body.length),
            ...(match ? { 'Content-Range': `bytes ${start}-${end}/${fixture.length}` } : {}),
        },
        body,
    });
}

async function exerciseInlineVideo(page: Page, playerTestId: string): Promise<void> {
    const player = page.getByTestId(playerTestId);
    const video = player.locator('video');
    await expect(player).toBeVisible();
    const playerBox = await player.boundingBox();
    if (!playerBox) throw new Error('找不到消息中的内联视频播放器');
    expect(playerBox.width).toBeGreaterThanOrEqual(300);
    expect(playerBox.width / playerBox.height).toBeCloseTo(16 / 9, 1);
    await expect(video).toHaveAttribute('controls', '');
    await expect.poll(() => video.evaluate((element) => {
        const media = element as HTMLVideoElement;
        return media.readyState >= HTMLMediaElement.HAVE_METADATA
            && Number.isFinite(media.duration)
            && media.duration > 1;
    }), { timeout: 10_000 }).toBe(true);

    const initialTime = await video.evaluate((element) => (element as HTMLVideoElement).currentTime);
    expect(initialTime).toBeLessThan(0.25);

    // Chromium's native media controls live in a closed user-agent shadow root,
    // so Playwright cannot address the Play button by role. Hovering and clicking
    // its visible bottom-left position still sends real pointer input to that control.
    await video.hover();
    await pauseForRecordedReview(page, 900);
    const videoBox = await video.boundingBox();
    if (!videoBox) throw new Error('找不到视频原生播放控件的可点击区域');
    const nativePlayPausePosition = { x: 24, y: videoBox.height - 48 };
    await video.click({ position: nativePlayPausePosition });
    await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).paused)).toBe(false);
    await pauseForRecordedReview(page, 1_800);
    await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime), {
        timeout: 5_000,
    }).toBeGreaterThanOrEqual(initialTime + 1);

    await video.hover();
    await video.click({ position: nativePlayPausePosition });
    await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).paused)).toBe(true);
    const pausedTime = await video.evaluate((element) => (element as HTMLVideoElement).currentTime);
    await pauseForRecordedReview(page, 900);
    await page.waitForTimeout(300);
    const timeAfterPause = await video.evaluate((element) => (element as HTMLVideoElement).currentTime);
    expect(timeAfterPause - pausedTime).toBeLessThan(0.2);

    const duration = await video.evaluate((element) => (element as HTMLVideoElement).duration);
    const progressBarInset = 16;
    const nativeSeekPosition = {
        x: progressBarInset + ((videoBox.width - (progressBarInset * 2)) * 0.82),
        y: videoBox.height - 24,
    };
    expect((duration * 0.82) - pausedTime).toBeGreaterThan(0.6);
    await video.hover({ position: nativeSeekPosition });
    await pauseForRecordedReview(page, 650);
    await video.click({ position: nativeSeekPosition });
    await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime), {
        timeout: 5_000,
    }).toBeGreaterThanOrEqual(Math.max(pausedTime + 0.6, duration * 0.7));
    await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).paused)).toBe(true);
    const seekedTime = await video.evaluate((element) => (element as HTMLVideoElement).currentTime);
    await pauseForRecordedReview(page, 1_100);
    await page.waitForTimeout(300);
    const timeAfterSeek = await video.evaluate((element) => (element as HTMLVideoElement).currentTime);
    expect(Math.abs(timeAfterSeek - seekedTime)).toBeLessThan(0.2);

    const nativeFullscreenPosition = { x: videoBox.width - 72, y: videoBox.height - 48 };
    await video.hover({ position: nativeFullscreenPosition });
    await video.click({ position: nativeFullscreenPosition });
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.tagName ?? null)).toBe('VIDEO');
    await pauseForRecordedReview(page);
    const fullscreenBox = await video.boundingBox();
    if (!fullscreenBox) throw new Error('找不到全屏视频的原生控件区域');
    const nativeExitFullscreenPosition = { x: fullscreenBox.width - 72, y: fullscreenBox.height - 48 };
    await video.hover({ position: nativeExitFullscreenPosition });
    await video.click({ position: nativeExitFullscreenPosition });
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.tagName ?? null)).toBe(null);
}

type CreateE2ESessionOptions = {
    agentState?: Record<string, unknown>;
    path?: string;
    host?: string;
    name?: string;
    summary?: string;
    flavor?: string;
    machineId?: string;
    homeDir?: string;
    parentSessionId?: string;
    claudeSessionId?: string;
    codexThreadId?: string;
    models?: Array<{
        code: string;
        value: string;
        description?: string | null;
        serviceTiers?: Array<{ id: string; name: string; description?: string | null }>;
    }>;
    currentModelCode?: string;
    thoughtLevels?: Array<{ code: string; value: string; description?: string | null }>;
    currentThoughtLevelCode?: string;
    currentOperatingModeCode?: string;
};

type CreateE2EUserMessageOptions = {
    text: string;
    model: string | null;
    effort: string | null;
    permission: string;
};

async function createE2ESession(
    request: APIRequestContext,
    options: CreateE2ESessionOptions = {},
): Promise<string> {
    const authUrl = new URL(authenticatedWebUrl);
    const token = authUrl.searchParams.get('dev_token');
    const secret = authUrl.searchParams.get('dev_secret');
    if (!token || !secret || !e2eServerUrl) {
        throw new Error('缺少创建 E2E 会话所需的本地认证配置。');
    }

    const encryptionKey = new Uint8Array(Buffer.from(secret, 'base64url'));
    const metadata = encodeBase64(encryptLegacy({
        path: options.path ?? '/tmp/paws-sidebar-e2e',
        host: options.host ?? 'playwright',
        name: options.name ?? 'Sidebar active-session regression',
        ...(options.summary ? { summary: { text: options.summary, updatedAt: Date.now() } } : {}),
        flavor: options.flavor ?? 'codex',
        ...(options.machineId ? { machineId: options.machineId } : {}),
        ...(options.homeDir ? { homeDir: options.homeDir } : {}),
        ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
        ...(options.claudeSessionId ? { claudeSessionId: options.claudeSessionId } : {}),
        ...(options.codexThreadId ? { codexThreadId: options.codexThreadId } : {}),
        ...(options.models ? { models: options.models } : {}),
        ...(options.currentModelCode ? { currentModelCode: options.currentModelCode } : {}),
        ...(options.thoughtLevels ? { thoughtLevels: options.thoughtLevels } : {}),
        ...(options.currentThoughtLevelCode ? { currentThoughtLevelCode: options.currentThoughtLevelCode } : {}),
        ...(options.currentOperatingModeCode ? { currentOperatingModeCode: options.currentOperatingModeCode } : {}),
        lifecycleState: 'running',
        startedBy: 'terminal',
    }, encryptionKey));
    const response = await request.post(new URL('/v1/sessions', e2eServerUrl).toString(), {
        data: {
            tag: `sidebar-e2e-${Date.now()}-${Math.random()}`,
            metadata,
            agentState: null,
            dataEncryptionKey: null,
        },
        headers: {
            Authorization: `Bearer ${token}`,
            'X-Happy-Client': 'playwright-e2e',
        },
    });
    expect(response.ok()).toBe(true);
    const body = await response.json() as { session: { id: string } };
    const sessionId = body.session.id;
    if (options.agentState) {
        const socket = io(e2eServerUrl, {
            auth: {
                token,
                clientType: 'session-scoped',
                sessionId,
                happyClient: 'playwright-session-state',
            },
            autoConnect: false,
            path: '/v1/updates',
            reconnection: false,
            transports: ['websocket'],
        });
        try {
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('写入 E2E 会话状态超时。')), 10_000);
                socket.once('connect_error', (error: Error) => {
                    clearTimeout(timeout);
                    reject(error);
                });
                socket.once('connect', () => {
                    const encrypted = encodeBase64(encryptLegacy(options.agentState, encryptionKey));
                    socket.emit('update-state', {
                        sid: sessionId,
                        expectedVersion: 0,
                        agentState: encrypted,
                    }, (result: { result: string }) => {
                        clearTimeout(timeout);
                        if (result.result === 'success') resolve();
                        else reject(new Error(`写入 E2E 会话状态失败：${result.result}`));
                    });
                });
                socket.connect();
            });
        } finally {
            socket.close();
        }
    }
    return sessionId;
}

async function appendE2ESessionEnvelopes(
    request: APIRequestContext,
    sessionId: string,
    envelopes: Array<Record<string, unknown>>,
): Promise<void> {
    const authUrl = new URL(authenticatedWebUrl);
    const token = authUrl.searchParams.get('dev_token');
    const secret = authUrl.searchParams.get('dev_secret');
    if (!token || !secret || !e2eServerUrl) {
        throw new Error('缺少创建 E2E Session envelope 所需的本地认证配置。');
    }

    const encryptionKey = new Uint8Array(Buffer.from(secret, 'base64url'));
    const response = await request.post(
        new URL(`/v3/sessions/${encodeURIComponent(sessionId)}/messages`, e2eServerUrl).toString(),
        {
            data: {
                messages: envelopes.map((envelope, index) => ({
                    content: encodeBase64(encryptLegacy({
                        role: 'session',
                        content: envelope,
                    }, encryptionKey)),
                    localId: `subagent-inspector-${index}-${Date.now()}-${Math.random()}`,
                })),
            },
            headers: {
                Authorization: `Bearer ${token}`,
                'X-Happy-Client': 'playwright-subagent-inspector',
            },
        },
    );
    expect(response.ok()).toBe(true);
}

async function createE2EUserMessage(
    request: APIRequestContext,
    sessionId: string,
    options: CreateE2EUserMessageOptions,
): Promise<void> {
    const authUrl = new URL(authenticatedWebUrl);
    const token = authUrl.searchParams.get('dev_token');
    const secret = authUrl.searchParams.get('dev_secret');
    if (!token || !secret || !e2eServerUrl) {
        throw new Error('缺少创建 E2E 用户消息所需的本地认证配置。');
    }

    const encryptionKey = new Uint8Array(Buffer.from(secret, 'base64url'));
    const response = await request.post(
        new URL(`/v3/sessions/${encodeURIComponent(sessionId)}/messages`, e2eServerUrl).toString(),
        {
            data: {
                messages: [{
                    content: encodeBase64(encryptLegacy({
                        role: 'user',
                        content: { type: 'text', text: options.text },
                        meta: {
                            sentFrom: 'playwright-e2e',
                            model: options.model,
                            effort: options.effort,
                            permissionMode: options.permission,
                        },
                    }, encryptionKey)),
                    localId: `composer-mode-e2e-${Date.now()}-${Math.random()}`,
                }],
            },
            headers: {
                Authorization: `Bearer ${token}`,
                'X-Happy-Client': 'playwright-e2e',
            },
        },
    );
    expect(response.ok()).toBe(true);
}

async function readE2EUserMessage(
    request: APIRequestContext,
    sessionId: string,
    expectedText: string,
): Promise<Record<string, unknown> | null> {
    const authUrl = new URL(authenticatedWebUrl);
    const token = authUrl.searchParams.get('dev_token');
    const secret = authUrl.searchParams.get('dev_secret');
    if (!token || !secret || !e2eServerUrl) {
        throw new Error('缺少读取 E2E 用户消息所需的本地认证配置。');
    }

    const response = await request.get(
        new URL(`/v3/sessions/${encodeURIComponent(sessionId)}/messages`, e2eServerUrl).toString(),
        {
            headers: {
                Authorization: `Bearer ${token}`,
                'X-Happy-Client': 'playwright-e2e',
            },
        },
    );
    expect(response.ok()).toBe(true);
    const body = await response.json() as {
        messages: Array<{ content: string | { t?: string; c?: string } }>;
    };
    const encryptionKey = new Uint8Array(Buffer.from(secret, 'base64url'));

    for (const message of body.messages) {
        const encrypted = typeof message.content === 'string' ? message.content : message.content.c;
        if (!encrypted) continue;
        const record = decryptLegacy(decodeBase64(encrypted), encryptionKey) as Record<string, unknown>;
        const content = record.content;
        if (
            record.role === 'user'
            && typeof content === 'object'
            && content !== null
            && (content as Record<string, unknown>).text === expectedText
        ) {
            return record;
        }
    }
    return null;
}

type E2EFileEvent = {
    encrypted?: boolean;
    kind?: string;
    mimeType?: string;
    name: string;
    ref: string;
    size: number;
    t: 'file';
};

async function readE2EFileEvent(
    request: APIRequestContext,
    sessionId: string,
    expectedName: string,
): Promise<E2EFileEvent | null> {
    const authUrl = new URL(authenticatedWebUrl);
    const token = authUrl.searchParams.get('dev_token');
    const secret = authUrl.searchParams.get('dev_secret');
    if (!token || !secret || !e2eServerUrl) {
        throw new Error('缺少读取 E2E 文件事件所需的本地认证配置。');
    }

    const response = await request.get(
        new URL(`/v3/sessions/${encodeURIComponent(sessionId)}/messages`, e2eServerUrl).toString(),
        {
            headers: {
                Authorization: `Bearer ${token}`,
                'X-Happy-Client': 'playwright-pdf-e2e',
            },
        },
    );
    expect(response.ok()).toBe(true);
    const body = await response.json() as {
        messages: Array<{ content: string | { t?: string; c?: string } }>;
    };
    const encryptionKey = new Uint8Array(Buffer.from(secret, 'base64url'));

    for (const message of body.messages) {
        const encrypted = typeof message.content === 'string' ? message.content : message.content.c;
        if (!encrypted) continue;
        const record = decryptLegacy(decodeBase64(encrypted), encryptionKey) as Record<string, unknown> | null;
        const content = record?.content;
        if (record?.role !== 'session' || typeof content !== 'object' || content === null) continue;
        const data = (content as { type?: string; data?: { ev?: E2EFileEvent } }).data;
        const event = data?.ev;
        if (event?.t === 'file' && event.name === expectedName) return event;
    }
    return null;
}

async function downloadE2EAttachment(
    request: APIRequestContext,
    sessionId: string,
    ref: string,
): Promise<Buffer> {
    const authUrl = new URL(authenticatedWebUrl);
    const token = authUrl.searchParams.get('dev_token');
    if (!token || !e2eServerUrl) {
        throw new Error('缺少下载 E2E 附件所需的本地认证配置。');
    }

    const sourceResponse = await request.post(
        new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/attachments/request-download`, e2eServerUrl).toString(),
        {
            data: { ref },
            headers: {
                Authorization: `Bearer ${token}`,
                'X-Happy-Client': 'playwright-pdf-e2e',
            },
        },
    );
    expect(sourceResponse.ok()).toBe(true);
    const { downloadUrl } = await sourceResponse.json() as { downloadUrl: string };
    const downloadResponse = await request.get(
        downloadUrl,
        new URL(downloadUrl).origin === new URL(e2eServerUrl).origin
            ? { headers: { Authorization: `Bearer ${token}` } }
            : {},
    );
    expect(downloadResponse.ok()).toBe(true);
    return downloadResponse.body();
}

async function createE2ECompletedToolCall(
    request: APIRequestContext,
    sessionId: string,
    options: {
        callId: string;
        input: Record<string, unknown>;
        isError?: boolean;
        name: string;
        output?: unknown;
    },
): Promise<void> {
    const authUrl = new URL(authenticatedWebUrl);
    const token = authUrl.searchParams.get('dev_token');
    const secret = authUrl.searchParams.get('dev_secret');
    if (!token || !secret || !e2eServerUrl) {
        throw new Error('缺少创建 E2E 工具消息所需的本地认证配置。');
    }

    const encryptionKey = new Uint8Array(Buffer.from(secret, 'base64url'));
    const encryptContent = (data: Record<string, unknown>) => encodeBase64(encryptLegacy({
        role: 'agent',
        content: {
            type: 'acp',
            provider: 'codex',
            data,
        },
        meta: { sentFrom: 'cli' },
    }, encryptionKey));
    const response = await request.post(
        new URL(`/v3/sessions/${encodeURIComponent(sessionId)}/messages`, e2eServerUrl).toString(),
        {
            data: {
                messages: [
                    {
                        content: encryptContent({
                            type: 'tool-call',
                            callId: options.callId,
                            id: options.callId,
                            input: options.input,
                            name: options.name,
                        }),
                        localId: `${options.callId}-call-${Date.now()}-${Math.random()}`,
                    },
                    {
                        content: encryptContent({
                            type: 'tool-result',
                            callId: options.callId,
                            id: `${options.callId}-result`,
                            isError: options.isError ?? false,
                            output: options.output ?? { success: true },
                        }),
                        localId: `${options.callId}-result-${Date.now()}-${Math.random()}`,
                    },
                ],
            },
            headers: {
                Authorization: `Bearer ${token}`,
                'X-Happy-Client': 'playwright-e2e',
            },
        },
    );
    expect(response.ok()).toBe(true);
}

async function createConnectedE2EFileSession(request: APIRequestContext): Promise<{
    client: { close: () => void };
    fileContent: string;
    fileName: string;
    filePath: string;
    sessionId: string;
    workspace: string;
}> {
    const authUrl = new URL(authenticatedWebUrl);
    const token = authUrl.searchParams.get('dev_token');
    const secret = authUrl.searchParams.get('dev_secret');
    if (!token || !secret || !e2eServerUrl) {
        throw new Error('缺少创建文件详情 E2E 会话所需的本地认证配置。');
    }

    const workspace = mkdtempSync(join(tmpdir(), 'paws-file-layout-e2e-'));
    const fileName = 'staged-cinematic-motion-blur-edit.md';
    const filePath = join(workspace, fileName);
    const fileContent = 'Keep the central photographer completely unchanged.';
    writeFileSync(filePath, fileContent, 'utf8');

    const encryptionKey = new Uint8Array(Buffer.from(secret, 'base64url'));
    const metadata = {
        path: workspace,
        homeDir: workspace,
        host: 'playwright',
        name: 'File viewer layout regression',
        flavor: 'codex',
        lifecycleState: 'running',
        startedBy: 'terminal',
    };
    const response = await request.post(new URL('/v1/sessions', e2eServerUrl).toString(), {
        data: {
            tag: `file-viewer-e2e-${Date.now()}-${Math.random()}`,
            metadata: encodeBase64(encryptLegacy(metadata, encryptionKey)),
            agentState: null,
            dataEncryptionKey: null,
        },
        headers: {
            Authorization: `Bearer ${token}`,
            'X-Happy-Client': 'playwright-e2e',
        },
    });
    if (!response.ok()) {
        rmSync(workspace, { force: true, recursive: true });
        throw new Error(`创建文件详情 E2E 会话失败：HTTP ${response.status()}`);
    }
    const body = await response.json() as { session: { id: string } };

    const sessionId = body.session.id;
    await createE2ECompletedToolCall(request, sessionId, {
        callId: 'file-viewer-layout-write',
        input: { file_path: filePath, content: fileContent },
        name: 'Write',
    });

    const rpcSocket = io(e2eServerUrl, {
        auth: {
            token,
            clientType: 'session-scoped',
            sessionId,
            happyClient: 'playwright-file-rpc',
        },
        autoConnect: false,
        path: '/v1/updates',
        reconnection: false,
        transports: ['websocket'],
    });
    rpcSocket.on('rpc-request', (data: { method: string; params: string }, callback: (response: string) => void) => {
        const params = decryptLegacy(decodeBase64(data.params), encryptionKey) as { path?: string } | null;
        const result = data.method === `${sessionId}:readFile` && params?.path === filePath
            ? { success: true, content: Buffer.from(fileContent, 'utf8').toString('base64') }
            : data.method === `${sessionId}:bash`
                ? { success: true, stdout: '', stderr: '', exitCode: 0 }
                : { success: false, error: 'Unknown E2E RPC request' };
        callback(encodeBase64(encryptLegacy(result, encryptionKey)));
    });
    try {
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('文件详情 E2E RPC 连接超时。')), 10_000);
            const handleConnectError = (error: Error) => {
                clearTimeout(timeout);
                reject(error);
            };
            rpcSocket.once('connect_error', handleConnectError);
            rpcSocket.once('connect', () => {
                clearTimeout(timeout);
                rpcSocket.off('connect_error', handleConnectError);
                rpcSocket.emit('rpc-register', { method: `${sessionId}:readFile` });
                rpcSocket.emit('rpc-register', { method: `${sessionId}:bash` });
                resolve();
            });
            rpcSocket.connect();
        });
    } catch (error) {
        rpcSocket.close();
        rmSync(workspace, { force: true, recursive: true });
        throw error;
    }

    return {
        client: { close: () => rpcSocket.close() },
        fileContent,
        fileName,
        filePath,
        sessionId,
        workspace,
    };
}

async function createConnectedE2EAbortSession(request: APIRequestContext): Promise<{
    abortCalls: Array<{ reason?: string } | null>;
    client: { close: () => void };
    sessionId: string;
    setThinking: (thinking: boolean) => void;
}> {
    const authUrl = new URL(authenticatedWebUrl);
    const token = authUrl.searchParams.get('dev_token');
    const secret = authUrl.searchParams.get('dev_secret');
    if (!token || !secret || !e2eServerUrl) {
        throw new Error('缺少创建停止快捷键 E2E 会话所需的本地认证配置。');
    }

    const encryptionKey = new Uint8Array(Buffer.from(secret, 'base64url'));
    const sessionId = await createE2ESession(request, {
        name: 'Double Escape abort regression',
        summary: 'Confirm abort only after pressing Escape twice',
    });
    const abortCalls: Array<{ reason?: string } | null> = [];
    const rpcSocket = io(e2eServerUrl, {
        auth: {
            token,
            clientType: 'session-scoped',
            sessionId,
            happyClient: 'playwright-abort-rpc',
        },
        autoConnect: false,
        path: '/v1/updates',
        reconnection: false,
        transports: ['websocket'],
    });

    rpcSocket.on('rpc-request', (
        data: { method: string; params: string },
        callback: (response: string) => void,
    ) => {
        const params = decryptLegacy(
            decodeBase64(data.params),
            encryptionKey,
        ) as { reason?: string } | null;
        const isAbort = data.method === `${sessionId}:abort`;
        if (isAbort) {
            abortCalls.push(params);
        }
        callback(encodeBase64(encryptLegacy(
            isAbort ? { success: true } : { success: false, error: 'Unknown E2E RPC request' },
            encryptionKey,
        )));
    });
    let thinking = true;
    const pulse = () => rpcSocket.emit('session-alive', {
        sid: sessionId,
        time: Date.now(),
        thinking,
    });

    try {
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('停止快捷键 E2E RPC 连接超时。')), 10_000);
            const handleConnectError = (error: Error) => {
                clearTimeout(timeout);
                reject(error);
            };
            rpcSocket.once('connect_error', handleConnectError);
            rpcSocket.once('connect', () => {
                rpcSocket.off('connect_error', handleConnectError);
                rpcSocket.once('rpc-registered', () => {
                    clearTimeout(timeout);
                    pulse();
                    resolve();
                });
                rpcSocket.emit('rpc-register', { method: `${sessionId}:abort` });
            });
            rpcSocket.connect();
        });
    } catch (error) {
        rpcSocket.close();
        throw error;
    }
    const keepAlive = setInterval(pulse, 500);

    return {
        abortCalls,
        client: {
            close: () => {
                clearInterval(keepAlive);
                rpcSocket.close();
            },
        },
        sessionId,
        setThinking: (nextThinking: boolean) => {
            thinking = nextThinking;
            pulse();
        },
    };
}

async function createConnectedE2EComposerModeSession(request: APIRequestContext): Promise<{
    client: {
        close: () => Promise<void>;
        goOffline: () => Promise<void>;
        reconnect: () => Promise<void>;
    };
    sessionId: string;
}> {
    const authUrl = new URL(authenticatedWebUrl);
    const token = authUrl.searchParams.get('dev_token');
    const secret = authUrl.searchParams.get('dev_secret');
    if (!token || !secret || !e2eServerUrl) {
        throw new Error('缺少创建输入区模式 E2E 会话所需的本地认证配置。');
    }

    const encryptionKey = new Uint8Array(Buffer.from(secret, 'base64url'));
    const machineId = `composer-mode-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const headers = {
        Authorization: `Bearer ${token}`,
        'X-Happy-Client': 'playwright-composer-mode-e2e',
    };
    const machineMetadata = encodeBase64(encryptLegacy({
        host: 'playwright-model-host',
        platform: 'darwin',
        happyCliVersion: '0.0.0-e2e',
        happyHomeDir: '/tmp/.happy',
        homeDir: '/tmp',
        cliAvailability: {
            ask: true,
            claude: true,
            codex: true,
            gemini: true,
            opencode: true,
            openclaw: true,
            detectedAt: Date.now(),
        },
    }, encryptionKey));

    const registerMachine = async () => {
        const response = await request.post(new URL('/v1/machines', e2eServerUrl).toString(), {
            data: { id: machineId, metadata: machineMetadata, dataEncryptionKey: null },
            headers,
        });
        expect(response.ok()).toBe(true);
    };
    const deleteMachine = async () => {
        const response = await request.delete(
            new URL(`/v1/machines/${encodeURIComponent(machineId)}`, e2eServerUrl).toString(),
            { headers },
        );
        expect(response.ok() || response.status() === 404).toBe(true);
    };
    await registerMachine();
    let sessionId: string;
    try {
        sessionId = await createE2ESession(request, {
            path: '/workspace/composer-mode-e2e',
            host: 'playwright-model-host',
            name: 'Composer permission, model and effort regression',
            summary: 'Validate UI metadata and offline continuity',
            flavor: 'codex',
            machineId,
            homeDir: '/tmp',
            currentOperatingModeCode: 'acceptEdits',
            models: [
                { code: 'gpt-5.5', value: 'gpt-5.5', description: 'Stable coding model' },
                {
                    code: 'gpt-5.6-sol',
                    value: 'gpt-5.6-sol',
                    description: 'Current coding model',
                    serviceTiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' }],
                },
            ],
            currentModelCode: 'gpt-5.6-sol',
            thoughtLevels: [
                { code: 'medium', value: 'medium', description: 'Balanced reasoning' },
                { code: 'high', value: 'high', description: 'Deep reasoning' },
                { code: 'xhigh', value: 'xhigh', description: 'Maximum reasoning' },
            ],
            currentThoughtLevelCode: 'xhigh',
        });
    } catch (error) {
        await deleteMachine();
        throw error;
    }
    const deactivateSession = async () => {
        const response = await request.post(
            new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/archive`, e2eServerUrl).toString(),
            { headers },
        );
        expect(response.ok()).toBe(true);
    };

    let socket: ReturnType<typeof io> | null = null;
    let keepAlive: ReturnType<typeof setInterval> | null = null;
    const pulse = () => socket?.emit('session-alive', {
        sid: sessionId,
        time: Date.now(),
        thinking: false,
    });
    const connect = async () => {
        socket = io(e2eServerUrl, {
            auth: {
                token,
                clientType: 'session-scoped',
                sessionId,
                happyClient: 'playwright-composer-mode-rpc',
            },
            autoConnect: false,
            path: '/v1/updates',
            reconnection: false,
            transports: ['websocket'],
        });
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('输入区模式 E2E Agent 连接超时。')), 10_000);
            socket!.once('connect_error', (error: Error) => {
                clearTimeout(timeout);
                reject(error);
            });
            socket!.once('connect', () => {
                clearTimeout(timeout);
                pulse();
                resolve();
            });
            socket!.connect();
        });
        keepAlive = setInterval(pulse, 500);
    };
    const disconnect = () => {
        if (keepAlive) clearInterval(keepAlive);
        keepAlive = null;
        socket?.close();
        socket = null;
    };

    try {
        await connect();
    } catch (error) {
        disconnect();
        await deleteMachine();
        throw error;
    }
    return {
        client: {
            close: async () => {
                disconnect();
                try {
                    await deleteMachine();
                } catch {
                    // The request fixture may already be closed after an aborted Playwright run.
                }
            },
            goOffline: async () => {
                disconnect();
                await deactivateSession();
                await deleteMachine();
            },
            reconnect: async () => {
                await registerMachine();
                await connect();
            },
        },
        sessionId,
    };
}

async function createConnectedE2EWorkingDirectorySession(request: APIRequestContext): Promise<{
    client: {
        close: () => Promise<void>;
        goOffline: () => Promise<void>;
        pulse: () => void;
        reconnect: () => Promise<void>;
    };
    currentPath: string;
    invalidPath: string;
    outsidePath: string;
    recentPath: string;
    rewindPoints: Array<{ itemId: string; text: string; timestamp: number }>;
    rpcCalls: Array<{
        method: string;
        params: {
            agent?: string;
            codexThreadId?: string;
            cutAfterItemId?: string;
            directory?: string;
            forkedFromMessageId?: string;
            parentSessionId?: string;
            path?: string;
            retainSelectedTurn?: boolean;
            resumeCodexThreadId?: string;
        } | null;
    }>;
    sessionId: string;
    sourceCodexThreadId: string;
    forkedCodexThreadId: string;
    workspace: string;
}> {
    const authUrl = new URL(authenticatedWebUrl);
    const token = authUrl.searchParams.get('dev_token');
    const secret = authUrl.searchParams.get('dev_secret');
    if (!token || !secret || !e2eServerUrl) {
        throw new Error('缺少创建工作目录 E2E 会话所需的本地认证配置。');
    }

    const workspace = mkdtempSync(join(tmpdir(), 'paws-cwd-e2e-'));
    const currentPath = join(workspace, 'current-project');
    const recentPath = join(workspace, 'recent-project');
    const invalidPath = join(workspace, 'missing-project');
    const outsidePath = path.dirname(workspace);
    fs.mkdirSync(currentPath, { recursive: true });
    fs.mkdirSync(recentPath, { recursive: true });

    const encryptionKey = new Uint8Array(Buffer.from(secret, 'base64url'));
    const machineId = `cwd-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sourceCodexThreadId = `cwd-source-thread-${Date.now()}`;
    const forkedCodexThreadId = `cwd-forked-thread-${Date.now()}`;
    const rewindPoints = [
        {
            itemId: 'message-hover-turn-1',
            text: 'Summarize the first checkpoint before we continue.',
            timestamp: Date.now() - 60_000,
        },
        {
            itemId: 'message-hover-turn-2',
            text: 'Add the browser verification details to the second checkpoint.',
            timestamp: Date.now() - 30_000,
        },
    ];
    const rpcCalls: Array<{
        method: string;
        params: {
            agent?: string;
            codexThreadId?: string;
            cutAfterItemId?: string;
            directory?: string;
            forkedFromMessageId?: string;
            parentSessionId?: string;
            path?: string;
            retainSelectedTurn?: boolean;
            resumeCodexThreadId?: string;
        } | null;
    }> = [];
    const headers = {
        Authorization: `Bearer ${token}`,
        'X-Happy-Client': 'playwright-cwd-e2e',
    };
    const machineMetadata = encodeBase64(encryptLegacy({
        host: 'playwright-cwd-agent',
        platform: 'darwin',
        happyCliVersion: '0.0.0-e2e',
        happyHomeDir: join(workspace, '.happy'),
        homeDir: workspace,
        cliAvailability: {
            ask: true,
            claude: true,
            codex: true,
            gemini: true,
            opencode: true,
            openclaw: true,
            detectedAt: Date.now(),
        },
    }, encryptionKey));
    const registerMachine = async () => {
        const response = await request.post(new URL('/v1/machines', e2eServerUrl).toString(), {
            data: { id: machineId, metadata: machineMetadata, dataEncryptionKey: null },
            headers,
        });
        if (!response.ok()) {
            throw new Error(`创建工作目录 E2E Agent 失败：HTTP ${response.status()}`);
        }
    };
    const deleteMachine = async () => {
        const response = await request.delete(
            new URL(`/v1/machines/${encodeURIComponent(machineId)}`, e2eServerUrl).toString(),
            { headers },
        );
        expect(response.ok() || response.status() === 404).toBe(true);
    };
    try {
        await registerMachine();
    } catch (error) {
        rmSync(workspace, { force: true, recursive: true });
        throw error;
    }

    await createE2ESession(request, {
        path: recentPath,
        host: 'playwright-cwd-agent',
        name: 'Recent working directory fixture',
        summary: 'A recent project on the same Agent',
        flavor: 'codex',
        machineId,
        homeDir: workspace,
    });
    const sessionId = await createE2ESession(request, {
        path: currentPath,
        host: 'playwright-cwd-agent',
        name: 'Working directory context regression',
        summary: 'Select and validate the next working directory',
        flavor: 'codex',
        machineId,
        homeDir: workspace,
        codexThreadId: sourceCodexThreadId,
    });

    let rpcSocket: ReturnType<typeof io> | null = null;
    let keepAlive: ReturnType<typeof setInterval> | null = null;
    const attachRpcHandler = (socket: ReturnType<typeof io>) => socket.on('rpc-request', (
        data: { method: string; params: string },
        callback: (response: string) => void,
    ) => {
        void (async () => {
            const params = decryptLegacy(decodeBase64(data.params), encryptionKey) as {
                agent?: string;
                codexThreadId?: string;
                cutAfterItemId?: string;
                directory?: string;
                forkedFromMessageId?: string;
                parentSessionId?: string;
                path?: string;
                retainSelectedTurn?: boolean;
                resumeCodexThreadId?: string;
            } | null;
            rpcCalls.push({ method: data.method, params });
            let result: unknown;

            if (data.method === `${machineId}:browseDirectory`) {
                const rawPath = params?.path?.trim() ?? '';
                const target = rawPath === '' || rawPath === '~'
                    ? workspace
                    : rawPath.startsWith('~/')
                        ? path.resolve(workspace, rawPath.slice(2))
                        : path.resolve(workspace, rawPath);
                const contained = target === workspace || target.startsWith(`${workspace}${path.sep}`);
                if (!contained) {
                    result = { success: false, error: 'Access denied: Path is outside this Agent home directory.' };
                } else if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
                    result = { success: false, error: 'Directory does not exist or cannot be accessed on this Agent.' };
                } else {
                    const directories = fs.readdirSync(target, { withFileTypes: true })
                        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
                        .map((entry) => ({
                            name: entry.name,
                            path: join(target, entry.name),
                            isProjectRoot: false,
                        }))
                        .sort((left, right) => left.name.localeCompare(right.name));
                    result = {
                        success: true,
                        path: target,
                        parent: target === workspace ? null : path.dirname(target),
                        home: workspace,
                        directories,
                    };
                }
            } else if (data.method === `${machineId}:codex-list-rewind-points`
                && params?.codexThreadId === sourceCodexThreadId
                && params.directory === currentPath) {
                result = { type: 'success', points: rewindPoints };
            } else if (data.method === `${machineId}:codex-duplicate-thread`
                && params?.codexThreadId === sourceCodexThreadId
                && params.directory === currentPath
                && params.retainSelectedTurn === true
                && rewindPoints.some((point) => point.itemId === params.cutAfterItemId)) {
                result = { type: 'success', newCodexThreadId: forkedCodexThreadId };
            } else if (data.method === `${machineId}:codex-fork-thread`
                && params?.codexThreadId === sourceCodexThreadId
                && params.directory === recentPath) {
                result = { type: 'success', newCodexThreadId: forkedCodexThreadId };
            } else if (data.method === `${machineId}:spawn-happy-session` && params?.directory) {
                const spawnedSessionId = await createE2ESession(request, {
                    path: params.directory,
                    host: 'playwright-cwd-agent',
                    name: 'Continued working directory session',
                    summary: 'Continued in the selected working directory',
                    flavor: params.agent ?? 'codex',
                    machineId,
                    homeDir: workspace,
                    parentSessionId: params.parentSessionId,
                    codexThreadId: params.resumeCodexThreadId,
                });
                result = { type: 'success', sessionId: spawnedSessionId };
            } else {
                result = { success: false, error: 'Unknown working directory E2E RPC request.' };
            }

            callback(encodeBase64(encryptLegacy(result, encryptionKey)));
        })().catch((error) => {
            callback(encodeBase64(encryptLegacy({
                success: false,
                error: error instanceof Error ? error.message : String(error),
            }, encryptionKey)));
        });
    });

    const pulse = () => rpcSocket?.emit('machine-alive', { machineId, time: Date.now() });
    const disconnect = () => {
        if (keepAlive) clearInterval(keepAlive);
        keepAlive = null;
        rpcSocket?.close();
        rpcSocket = null;
    };
    const connect = async () => {
        const socket = io(e2eServerUrl, {
            auth: {
                token,
                clientType: 'machine-scoped',
                machineId,
                happyClient: 'playwright-cwd-rpc',
            },
            autoConnect: false,
            path: '/v1/updates',
            reconnection: false,
            transports: ['websocket'],
        });
        rpcSocket = socket;
        attachRpcHandler(socket);
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('工作目录 E2E RPC 连接超时。')), 10_000);
            const pendingMethods = new Set([
                `${machineId}:browseDirectory`,
                `${machineId}:codex-list-rewind-points`,
                `${machineId}:codex-duplicate-thread`,
                `${machineId}:codex-fork-thread`,
                `${machineId}:spawn-happy-session`,
            ]);
            const handleRegistered = ({ method }: { method: string }) => {
                pendingMethods.delete(method);
                if (pendingMethods.size > 0) return;
                clearTimeout(timeout);
                socket.off('connect_error', handleConnectError);
                socket.off('rpc-registered', handleRegistered);
                pulse();
                resolve();
            };
            const handleConnectError = (error: Error) => {
                clearTimeout(timeout);
                socket.off('rpc-registered', handleRegistered);
                reject(error);
            };
            socket.once('connect_error', handleConnectError);
            socket.on('rpc-registered', handleRegistered);
            socket.once('connect', () => {
                for (const method of pendingMethods) socket.emit('rpc-register', { method });
            });
            socket.connect();
        });
        keepAlive = setInterval(pulse, 500);
    };
    try {
        await connect();
    } catch (error) {
        disconnect();
        await deleteMachine();
        rmSync(workspace, { force: true, recursive: true });
        throw error;
    }

    return {
        client: {
            pulse,
            close: async () => {
                disconnect();
                try {
                    await deleteMachine();
                } catch {
                    // The request fixture is already closed when Playwright aborts on timeout.
                } finally {
                    rmSync(workspace, { force: true, recursive: true });
                }
            },
            goOffline: async () => {
                disconnect();
                await deleteMachine();
            },
            reconnect: async () => {
                await registerMachine();
                await connect();
            },
        },
        currentPath,
        forkedCodexThreadId,
        invalidPath,
        outsidePath,
        recentPath,
        rewindPoints,
        rpcCalls,
        sessionId,
        sourceCodexThreadId,
        workspace,
    };
}

async function dragHorizontalResizeHandle(page: Page, handle: Locator, deltaX: number): Promise<void> {
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + Math.min(100, box!.height / 2));
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + deltaX, box!.y + Math.min(100, box!.height / 2), {
        steps: 10,
    });
    await page.mouse.up();
}

async function renderedLineTexts(locator: Locator): Promise<string[]> {
    return locator.evaluate((element) => {
        const chars: Array<{ top: number; value: string }> = [];
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node) {
            const value = node.textContent ?? '';
            for (let index = 0; index < value.length; index += 1) {
                if (/\s/.test(value[index])) continue;
                const range = document.createRange();
                range.setStart(node, index);
                range.setEnd(node, index + 1);
                const rect = range.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    chars.push({ top: Math.round(rect.top), value: value[index] });
                }
            }
            node = walker.nextNode();
        }

        const lines: Array<{ top: number; value: string }> = [];
        for (const char of chars) {
            let line = lines.find((candidate) => Math.abs(candidate.top - char.top) <= 1);
            if (!line) {
                line = { top: char.top, value: '' };
                lines.push(line);
            }
            line.value += char.value;
        }
        return lines.sort((left, right) => left.top - right.top).map((line) => line.value);
    });
}

const viewports = [
    { name: '窄屏', width: 799, height: 900 },
    { name: '断点宽度', width: 800, height: 900 },
    { name: '宽屏', width: 1280, height: 900 },
] as const;

const expectedIsolatedDevRouteLoadEvidence = {
    warningCount: 0,
    errorCount: 6,
    failedRequestCount: 6,
    consoleErrorKinds: Array(6).fill('resource-load'),
    failedRequestTypes: Array(6).fill('fetch'),
    failedRequestReasons: Array(6).fill('net::ERR_CONNECTION_REFUSED'),
};

test('中文欢迎页在四档桌面视口没有孤字收尾', async ({ browser }, testInfo) => {
    const context = await browser.newContext({ locale: 'zh-CN', deviceScaleFactor: 1 });
    const page = await context.newPage();
    const url = new URL(authenticatedWebUrl);
    url.pathname = '/';
    url.search = '';
    url.hash = '';

    try {
        for (const viewport of [
            { width: 1024, height: 768 },
            { width: 1280, height: 720 },
            { width: 1440, height: 900 },
            { width: 1920, height: 1080 },
        ]) {
            await page.setViewportSize(viewport);
            await page.goto(url.toString());
            const titleLines = await renderedLineTexts(page.getByTestId('welcome-title'));
            const subtitleLines = await renderedLineTexts(page.getByTestId('welcome-subtitle'));
            expect(titleLines.at(-1)?.length ?? 0, '欢迎页标题不得以一到两个字孤行收尾').toBeGreaterThan(2);
            expect(subtitleLines.at(-1)?.length ?? 0, '欢迎页说明不得以一到两个字孤行收尾').toBeGreaterThan(2);
            await page.screenshot({
                path: testInfo.outputPath(`welcome-after-${viewport.width}x${viewport.height}.png`),
                fullPage: true,
            });
        }
    } finally {
        await context.close();
    }
});

test.describe('会话行组织可见回归', () => {
    test('NAV-13-01：Codex 项目行默认收敛，悬停滚动标题并在右侧显示详情', async ({ page, request }, testInfo) => {
        const title = 'Session row title that is intentionally long enough to overflow the compact navigation column';
        const sessionId = await createE2ESession(request, {
            path: '/workspace/session-row-location-details',
            summary: title,
            flavor: 'codex',
        });

        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto(authenticatedRoute('/new'));
        const row = page.getByTestId(`session-row-${sessionId}`);
        await expect(row).toBeVisible();
        await expect(page.getByTestId(`session-row-status-${sessionId}`)).toHaveCount(0);
        await expect(page.getByTestId(`session-row-actions-${sessionId}`).getByRole('button')).toHaveCount(0);
        const titleViewport = row.getByTestId('session-row-title');
        await expect(titleViewport).toHaveAttribute('data-marquee-active', 'false');

        await row.hover();
        const details = page.getByTestId('session-row-details');
        await expect(details).toBeVisible();
        await expect(details).toContainText(title);
        await expect(details).toContainText('/workspace/session-row-location-details');
        await expect(details).toContainText('Codex');
        await expect(titleViewport).toHaveAttribute('data-marquee-active', 'true');
        await expect(page.getByTestId('session-row-hover-status')).toBeVisible();
        const pinAction = page.getByTestId(`session-row-actions-${sessionId}`).getByTestId('session-row-pin-action');
        const deleteAction = page.getByTestId(`session-row-actions-${sessionId}`).getByTestId('session-row-delete-action');
        const archiveAction = page.getByTestId(`session-row-actions-${sessionId}`).getByTestId('session-row-archive-action');
        await expect(pinAction).toBeVisible();
        await expect(deleteAction).toBeVisible();
        await expect(archiveAction).toBeVisible();
        await expect(pinAction.getByTestId('session-row-pin-action-icon')).toHaveAttribute('data-icon-name', 'pin');
        await expect(deleteAction.getByTestId('session-row-delete-action-icon')).toHaveAttribute('data-icon-name', 'trash');
        await expect(archiveAction.getByTestId('session-row-archive-action-icon')).toHaveAttribute('data-icon-name', 'archive');
        await expect(deleteAction).toHaveAccessibleName('Delete Session');
        await deleteAction.hover();
        await expect(page.getByTestId('session-row-delete-action-tooltip')).toContainText('Delete Session');
        const sidebarBox = await page.getByTestId('desktop-left-sidebar').boundingBox();
        const detailsBox = await details.boundingBox();
        const actionsBox = await page.getByTestId(`session-row-actions-${sessionId}`).boundingBox();
        if (!sidebarBox || !detailsBox || !actionsBox) throw new Error('找不到 Codex 侧栏、操作区或右侧详情浮层');
        expect(actionsBox.x + actionsBox.width).toBeLessThanOrEqual(sidebarBox.x + sidebarBox.width + 1);
        expect(detailsBox.x).toBeGreaterThanOrEqual(sidebarBox.x + sidebarBox.width + 16);
        await page.screenshot({
            path: testInfo.outputPath('nav-13-01-hover-details-1280x900.png'),
            fullPage: true,
        });

        await page.mouse.move(1270, 890);
        await expect(details).toHaveCount(0);
    });

    test('NAV-13-02：键盘焦点显示详情，快捷操作不触发行导航', async ({ page, request }, testInfo) => {
        const sessionId = await createE2ESession(request, {
            path: '/workspace/session-row-keyboard',
            summary: 'Keyboard focus session row',
        });

        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto(authenticatedRoute('/new'));
        const row = page.getByTestId(`session-row-${sessionId}`);
        await row.focus();
        await expect(row).toBeFocused();
        await expect(page.getByTestId('session-row-details')).toBeVisible();

        await expect(page.getByTestId('session-row-details-action')).toHaveCount(0);
        await expect(page.getByTestId('session-row-hover-status')).toBeVisible();
        const pinAction = page.getByTestId('session-row-pin-action');
        await expect(pinAction).toHaveAccessibleName('Pin Session');
        await pinAction.hover();
        await expect(page.getByTestId('session-row-pin-action-tooltip')).toBeVisible();
        await expect(page.getByTestId('session-row-pin-action-tooltip')).toContainText('Pin Session');
        await pinAction.click();
        await expect.poll(() => new URL(page.url()).pathname).toBe('/new');
        await expect(pinAction).toHaveAccessibleName('Unpin Session');
        await page.screenshot({
            path: testInfo.outputPath('nav-13-02-keyboard-actions-1280x900.png'),
            fullPage: true,
        });

        await page.keyboard.press('Escape');
        await expect(page.getByTestId('session-row-details')).toHaveCount(0);
    });

    test('NAV-13-03：归档后默认消失，归档筛选提供 Restore 而非 Resume', async ({ page, request }, testInfo) => {
        const sessionId = await createE2ESession(request, {
            path: '/workspace/session-row-restore',
            summary: 'Archive and restore this session row',
        });

        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto(authenticatedWebUrl);
        let row = page.getByTestId(`session-row-${sessionId}`);
        await row.hover();
        await page.getByTestId(`session-row-actions-${sessionId}`)
            .getByTestId('session-row-archive-action')
            .click();
        await expect(row).toHaveCount(0);

        await page.getByTestId('session-archive-toggle').click();
        row = page.getByTestId(`session-row-${sessionId}`);
        await expect(row).toBeVisible();
        await row.hover();
        const restoreAction = page.getByTestId(`session-row-actions-${sessionId}`)
            .getByTestId('session-row-restore-action');
        await expect(restoreAction).toHaveAccessibleName('Restore Session');
        await expect(restoreAction.getByTestId('session-row-restore-action-icon')).toHaveAttribute('data-icon-name', 'undo');
        await expect(page.getByRole('button', { name: 'Resume Session' })).toHaveCount(0);
        await page.screenshot({
            path: testInfo.outputPath('nav-13-03-archived-restore-1280x900.png'),
            fullPage: true,
        });

        await restoreAction.click();
        const restoredRow = page.getByTestId(`session-row-${sessionId}`);
        await expect(restoredRow).toBeVisible();
        await restoredRow.hover();
        await expect(page.getByTestId('session-row-details')).toContainText(/disconnected/i);
    });

    test('NAV-13-04：799px 窄屏 More 菜单具备置顶和归档权限', async ({ page, request }, testInfo) => {
        const sessionId = await createE2ESession(request, {
            path: '/workspace/session-row-more-menu',
            summary: 'Narrow row action parity',
        });

        await page.setViewportSize({ width: 799, height: 900 });
        await page.goto(authenticatedWebUrl);
        await page.locator('[data-testid="compose-home-drawer-button"]:visible').click();
        const row = page.getByTestId(`session-row-${sessionId}`);
        await expect(row).toBeVisible();
        const more = page.getByTestId(`session-row-actions-${sessionId}`)
            .getByTestId('session-row-more-action');
        await expect(more).toBeVisible();
        await expect(more.getByTestId('session-row-more-action-icon')).toHaveAttribute('data-icon-name', 'kebab-horizontal');
        await more.click();
        await expect(page.getByTestId('session-actions-inline-menu')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Pin Session' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Archive Session' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Delete Session' })).toBeVisible();
        await page.screenshot({
            path: testInfo.outputPath('nav-13-04-narrow-more-799x900.png'),
            fullPage: true,
        });
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('session-actions-inline-menu')).toHaveCount(0);
    });

    test('NAV-13-05：宽屏触控 Web 仍提供 More，不依赖 hover', async ({ browser, request }) => {
        const sessionId = await createE2ESession(request, {
            path: '/workspace/session-row-wide-touch',
            summary: 'Wide touch row action parity',
        });
        const context = await browser.newContext({
            deviceScaleFactor: 1,
            hasTouch: true,
            locale: 'en-US',
            viewport: { width: 1280, height: 900 },
        });
        const page = await context.newPage();
        try {
            await page.goto(authenticatedRoute('/new'));
            await expect.poll(() => page.evaluate(() => (
                window.matchMedia('(hover: hover) and (pointer: fine)').matches
            ))).toBe(false);
            const actions = page.getByTestId(`session-row-actions-${sessionId}`);
            await expect(actions.getByTestId('session-row-more-action')).toBeVisible();
            await expect(actions.getByTestId('session-row-pin-action')).toHaveCount(0);
        } finally {
            await context.close();
        }
    });
});

for (const viewport of viewports) {
    test(`${viewport.name}首页可输入且没有 OTA 蒙层`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(authenticatedWebUrl);

        const composer = page.getByRole('textbox');
        await expect(composer).toHaveCount(1);
        await expect(composer).toBeVisible();
        await expect(page.getByRole('button', { name: /OTA/i })).toHaveCount(0);

        const hitTargetIsComposer = await composer.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const hitTarget = document.elementFromPoint(
                rect.left + rect.width / 2,
                rect.top + rect.height / 2,
            );
            return hitTarget === element;
        });
        expect(hitTargetIsComposer).toBe(true);

        await composer.click();
        await expect(composer).toBeFocused();
        await composer.fill('浏览器 E2E 点击探针');
        await expect(composer).toHaveValue('浏览器 E2E 点击探针');
    });
}

test('Web 启动不会注册无效的 push token listener', async ({ page }) => {
    const unsupportedPushTokenWarnings: string[] = [];
    page.on('console', (message) => {
        if (message.type() === 'warning' && message.text().includes('Listening to push token changes')) {
            unsupportedPushTokenWarnings.push(message.text());
        }
    });

    await page.goto(new URL('/new', authenticatedWebUrl).toString());
    await expect(page.getByRole('textbox')).toBeVisible();

    expect(unsupportedPushTokenWarnings).toEqual([]);
});

test('[R10-02][CWD-03-01] 工作目录拒绝越界并在 Agent 离线重连后继续', async ({ page, request }, testInfo) => {
    const fixture = await createConnectedE2EWorkingDirectorySession(request);
    const draft = 'Keep this draft when continuing in the selected directory.';

    try {
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto(authenticatedRoute(`/session/${fixture.sessionId}`));
        fixture.client.pulse();

        const input = page.getByTestId('session-message-input');
        const sendButton = page.locator('[data-testid="message-composer-send-button"]:visible');
        const directoryTrigger = page.getByTestId('session-working-directory-trigger');
        await expect(input).toBeVisible();
        await input.fill(draft);
        await expect(sendButton).not.toHaveAttribute('aria-disabled', 'true');
        await expect(directoryTrigger).toBeVisible();
        await expect(directoryTrigger).toContainText('~/current-project');
        await expect(directoryTrigger).toHaveAttribute(
            'aria-label',
            `Working directory: ${fixture.currentPath}`,
        );

        await directoryTrigger.hover();
        await expect(page.getByTestId('session-working-directory-tooltip')).toHaveText(fixture.currentPath);
        await directoryTrigger.click();

        const dialog = page.getByTestId('session-working-directory-dialog');
        await expect(dialog).toBeVisible();
        await expect(dialog.getByText('Working directory', { exact: true })).toBeVisible();
        await expect(dialog.getByText(
            'Changing it continues in a new session and affects the next and future messages. This session stays unchanged.',
            { exact: true },
        )).toBeVisible();
        await expect(dialog.getByTestId('session-working-directory-input')).toHaveValue(fixture.currentPath);
        await expect(dialog.getByTestId('session-working-directory-browse')).toContainText('Browse folders');
        const recentDirectory = dialog.getByTestId('session-working-directory-recent-~/recent-project');
        await expect(recentDirectory).toContainText('~/recent-project');
        await expect(recentDirectory).toContainText(fixture.recentPath);
        await page.waitForTimeout(350);
        await page.screenshot({
            path: testInfo.outputPath('cwd-context-001-after-1280x900.png'),
            fullPage: true,
        });

        await dialog.getByTestId('session-working-directory-browse').click();
        await expect(dialog.getByTestId('session-working-directory-use-current')).toContainText('Use ~/current-project');
        await dialog.getByLabel('Back').click();
        await expect(dialog.getByTestId('session-working-directory-browse-recent-project')).toBeVisible();
        await dialog.getByLabel('Cancel').click();

        await directoryTrigger.click();
        const directoryInput = dialog.getByTestId('session-working-directory-input');
        await directoryInput.fill(fixture.invalidPath);
        await expect(sendButton).toHaveAttribute('aria-disabled', 'true');
        await dialog.getByTestId('session-working-directory-continue').click();
        const error = dialog.getByTestId('session-working-directory-error');
        await expect(error).toContainText('This directory cannot be used. Check the path and access, then try again.');
        await expect(error).toContainText('Directory does not exist or cannot be accessed on this Agent.');
        await expect(sendButton).toHaveAttribute('aria-disabled', 'true');
        await page.waitForTimeout(350);
        await page.screenshot({
            path: testInfo.outputPath('cwd-context-002-after-1280x900.png'),
            fullPage: true,
        });

        await directoryInput.fill(fixture.outsidePath);
        await dialog.getByTestId('session-working-directory-continue').click();
        await expect(error).toContainText('Access denied: Path is outside this Agent home directory.');
        await expect(sendButton).toHaveAttribute('aria-disabled', 'true');

        await directoryInput.fill(fixture.recentPath);
        await fixture.client.goOffline();
        await expect(directoryInput).toHaveValue(fixture.recentPath);
        await expect(input).toHaveValue(draft);
        const browseButton = dialog.getByTestId('session-working-directory-browse');
        const continueButton = dialog.getByTestId('session-working-directory-continue');
        await expect(browseButton).toHaveAttribute('aria-disabled', 'true');
        await continueButton.click();
        await expect(error).toContainText('The Agent machine is offline. Reconnect it before changing directories.');
        await expect(directoryInput).toHaveValue(fixture.recentPath);
        await expect(input).toHaveValue(draft);
        await expect(sendButton).toHaveAttribute('aria-disabled', 'true');

        await fixture.client.reconnect();
        await expect(browseButton).not.toHaveAttribute('aria-disabled', 'true');
        await expect(directoryInput).toHaveValue(fixture.recentPath);
        await expect(input).toHaveValue(draft);
        await continueButton.click();
        await expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 })
            .not.toBe(`/session/${fixture.sessionId}`);
        await expect(page.getByTestId('session-message-input')).toHaveValue(draft);
        await expect(page.getByTestId('session-working-directory-trigger')).toContainText('~/recent-project');

        const continuationCalls = fixture.rpcCalls.filter((call) => (
            call.method.endsWith(':codex-fork-thread')
            || call.method.endsWith(':spawn-happy-session')
        ));
        expect(continuationCalls).toHaveLength(2);
        expect(continuationCalls[0]).toMatchObject({
            method: expect.stringMatching(/:codex-fork-thread$/),
            params: {
                codexThreadId: fixture.sourceCodexThreadId,
                directory: fixture.recentPath,
            },
        });
        expect(continuationCalls[1]).toMatchObject({
            method: expect.stringMatching(/:spawn-happy-session$/),
            params: {
                agent: 'codex',
                directory: fixture.recentPath,
                parentSessionId: fixture.sessionId,
                resumeCodexThreadId: fixture.forkedCodexThreadId,
            },
        });

        await page.goto(authenticatedRoute(`/session/${fixture.sessionId}`));
        fixture.client.pulse();
        await expect(page.getByTestId('session-working-directory-trigger')).toContainText('~/current-project');
    } finally {
        await page.close();
        await fixture.client.close();
    }
});

test('[MESSAGE-HOVER-ACTIONS] PC Agent 回复悬浮后直接从所属回合分叉', async ({ page, request }, testInfo) => {
    test.slow();
    test.setTimeout(1_200_000);
    const fixture = await createConnectedE2EWorkingDirectorySession(request);
    const firstResponse = 'The first checkpoint is complete and preserved in this turn.';
    const secondResponse = 'The second checkpoint includes browser assertions, a screenshot, and the recorded RPC boundary.';
    fixture.rewindPoints[0].text = fixture.rewindPoints[1].text;
    const baseTime = fixture.rewindPoints[0].timestamp;
    const pulseTimer = setInterval(() => fixture.client.pulse(), 60_000);

    try {
        await appendE2ESessionEnvelopes(request, fixture.sessionId, [
            {
                id: 'message-hover-user-1',
                time: baseTime,
                role: 'user',
                turn: 'message-hover-turn-1',
                ev: { t: 'text', text: fixture.rewindPoints[0].text },
            },
            {
                id: 'message-hover-agent-1',
                time: baseTime + 10_000,
                role: 'agent',
                turn: 'message-hover-turn-1',
                ev: { t: 'text', text: firstResponse },
            },
            {
                id: 'message-hover-user-2',
                time: fixture.rewindPoints[1].timestamp,
                role: 'user',
                turn: 'message-hover-turn-2',
                ev: { t: 'text', text: fixture.rewindPoints[1].text },
            },
            {
                id: 'message-hover-agent-2',
                time: fixture.rewindPoints[1].timestamp + 10_000,
                role: 'agent',
                turn: 'message-hover-turn-2',
                ev: { t: 'text', text: secondResponse },
            },
        ]);
        await page.setViewportSize({ width: 1280, height: 720 });

        await page.addInitScript(() => {
            window.localStorage.setItem(
                'mmkv.default\\pending-settings',
                JSON.stringify({ expResumeSession: true }),
            );
            window.localStorage.setItem(
                'mmkv.default\\local-settings',
                JSON.stringify({ themePreference: 'dark', themePack: 'gingham' }),
            );
        });
        await page.emulateMedia({ colorScheme: 'dark' });

        await page.goto(authenticatedRoute('/settings/features'), {
            waitUntil: 'commit',
            timeout: 30_000,
        });
        const resumeSwitch = page.getByRole('switch', { name: 'Resume Session' });
        const initializationError = page.getByRole('button', { name: /Error initializing:/ });
        await expect(resumeSwitch.or(initializationError)).toBeVisible({ timeout: 120_000 });
        if (await initializationError.isVisible()) {
            await page.reload({ waitUntil: 'commit', timeout: 30_000 });
        }
        await expect(resumeSwitch).toBeVisible({ timeout: 120_000 });

        await page.goto(authenticatedRoute(`/session/${fixture.sessionId}`), {
            waitUntil: 'commit',
            timeout: 30_000,
        });
        fixture.client.pulse();
        const secondResponseText = page.getByText(secondResponse, { exact: true });
        await expect(secondResponseText.or(initializationError)).toBeVisible({ timeout: 120_000 });
        if (await initializationError.isVisible()) {
            await page.reload({ waitUntil: 'commit', timeout: 30_000 });
            fixture.client.pulse();
        }
        await expect(secondResponseText).toBeVisible({ timeout: 120_000 });

        if (messageHoverEvidencePhase === 'before') {
            const responseContainer = secondResponseText.locator(
                'xpath=ancestor::*[starts-with(@data-testid, "message-agent-")]',
            ).first();
            await responseContainer.hover();
            await expect(responseContainer.getByRole('button', { name: 'Copy' })).toHaveCount(0);
            await expect(responseContainer.getByRole('button', { name: 'Fork from here' })).toHaveCount(0);
            await page.screenshot({
                path: messageHoverScreenshotPath(testInfo),
                animations: 'disabled',
            });
            return;
        }

        // This case uses a fixed 1280x720 viewport. Native mouse input avoids the
        // expensive Playwright actionability loop while RN Web is settling.
        await page.mouse.move(640, 520);
        await pauseForRecordedReview(page, 400);
        const forkButtonCenter = await page.evaluate(() => {
            const forkButton = document.querySelector<HTMLElement>('[aria-label="Fork from here"]');
            if (!forkButton) return null;
            const bounds = forkButton.getBoundingClientRect();
            return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
        });
        expect(forkButtonCenter).not.toBeNull();
        await page.mouse.move(forkButtonCenter!.x, forkButtonCenter!.y);
        await pauseForRecordedReview(page, 1_100);
        const forkTooltipAlignment = await page.evaluate(() => {
            const forkButton = document.querySelector<HTMLElement>('[aria-label="Fork from here"]');
            const forkTooltip = document.querySelector<HTMLElement>(
                '[data-testid^="message-agent-fork-tooltip-"]',
            );
            if (!forkButton || !forkTooltip) return null;
            const buttonBounds = forkButton.getBoundingClientRect();
            const tooltipBounds = forkTooltip.getBoundingClientRect();
            return {
                buttonCenterX: buttonBounds.left + buttonBounds.width / 2,
                tooltipCenterX: tooltipBounds.left + tooltipBounds.width / 2,
            };
        });
        expect(forkTooltipAlignment).not.toBeNull();
        expect(Math.abs(
            forkTooltipAlignment!.tooltipCenterX - forkTooltipAlignment!.buttonCenterX,
        )).toBeLessThanOrEqual(1);
        const actionHitTargets = await page.evaluate(() => {
            const inspectButton = (label: string) => {
                const button = document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
                if (!button) return null;
                const bounds = button.getBoundingClientRect();
                const inset = 3;
                const points = [
                    [bounds.left + inset, bounds.top + inset],
                    [bounds.right - inset, bounds.top + inset],
                    [bounds.left + inset, bounds.bottom - inset],
                    [bounds.right - inset, bounds.bottom - inset],
                    [bounds.left + bounds.width / 2, bounds.top + bounds.height / 2],
                ];
                return points.map(([x, y]) => (
                    document.elementFromPoint(x, y)?.closest('button') === button
                ));
            };
            return {
                copy: inspectButton('Copy'),
                fork: inspectButton('Fork from here'),
            };
        });
        expect(actionHitTargets).toEqual({
            copy: [true, true, true, true, true],
            fork: [true, true, true, true, true],
        });
        await page.screenshot({
            path: messageHoverScreenshotPath(testInfo),
            animations: 'disabled',
        });

        const forkClicked = await page.evaluate(() => {
            const forkButton = document.querySelector<HTMLElement>('[aria-label="Fork from here"]');
            if (!forkButton) return false;
            forkButton.click();
            return true;
        });
        expect(forkClicked).toBe(true);
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect.poll(
            () => fixture.rpcCalls.some((call) => call.method.endsWith(':codex-list-rewind-points')),
            { timeout: 15_000 },
        ).toBe(true);
        await expect.poll(
            () => fixture.rpcCalls.some((call) => call.method.endsWith(':codex-duplicate-thread')),
            { timeout: 15_000 },
        ).toBe(true);
        await expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 })
            .not.toBe(`/session/${fixture.sessionId}`);

        const duplicateCall = fixture.rpcCalls.find((call) => call.method.endsWith(':codex-duplicate-thread'));
        expect(duplicateCall).toMatchObject({
            params: {
                codexThreadId: fixture.sourceCodexThreadId,
                cutAfterItemId: fixture.rewindPoints[1].itemId,
                directory: fixture.currentPath,
                retainSelectedTurn: true,
            },
        });
        const forkRpcMethods = fixture.rpcCalls
            .filter((call) => call.method.includes(':codex-'))
            .map((call) => call.method.slice(call.method.lastIndexOf(':') + 1));
        expect(forkRpcMethods).toEqual([
            'codex-list-rewind-points',
            'codex-duplicate-thread',
        ]);
        const spawnCall = fixture.rpcCalls.find((call) => call.method.endsWith(':spawn-happy-session'));
        expect(spawnCall).toMatchObject({
            params: {
                agent: 'codex',
                directory: fixture.currentPath,
                parentSessionId: fixture.sessionId,
                resumeCodexThreadId: fixture.forkedCodexThreadId,
            },
        });
        expect(spawnCall?.params?.forkedFromMessageId).toEqual(expect.any(String));
        await page.screenshot({
            path: messageHoverScreenshotPath(testInfo, 2),
            animations: 'disabled',
        });
    } finally {
        clearInterval(pulseTimer);
        await page.close();
        await fixture.client.close();
    }
});

test('[CODEX-FORK-TRANSCRIPT] 分叉回填隐藏内部提示词但保留用户请求', async ({ page, request }, testInfo) => {
    test.slow();
    test.setTimeout(300_000);
    const realUserRequest = '我现在重新测试 Fork';
    const legacyUserRequest = '旧会话中的用户请求也要保留';
    const internalPromptText = 'Internal Happy system instruction (redacted test fixture).';
    const legacyRuntimeText = '# AGENTS.md instructions\n\n<environment_context>internal runtime context</environment_context>';
    const codexRuntimeStatus =
        'Happy has already applied these Codex runtime settings for this turn: model=gpt-5.6-sol, reasoning_effort=high. ' +
        'If the user asks to switch to one of these settings, acknowledge that it is already active; do not look for a tool or API to change it.';
    const rawEnvelopes = [{
        id: 'fork-transcript-raw-prompt',
        time: Date.now(),
        role: 'user',
        turn: 'fork-transcript-turn',
        codexItemId: 'fork-transcript-raw-prompt',
        ev: { t: 'text', text: `${internalPromptText}\n\n${legacyRuntimeText}\n\n${realUserRequest}` },
    }];
    const markedAndLegacyEnvelopes = [{
        id: 'fork-transcript-prompt',
        time: Date.now(),
        role: 'user',
        turn: 'fork-transcript-turn',
        codexItemId: 'fork-transcript-prompt',
        ev: {
            t: 'text',
            text: [
                '<!-- happy:system-prompt:start -->',
                codexRuntimeStatus,
                '<!-- happy:system-prompt:end -->',
                '',
                realUserRequest,
            ].join('\n'),
        },
    }, {
        id: 'fork-transcript-legacy-prompt',
        time: Date.now() + 1,
        role: 'user',
        turn: 'fork-transcript-legacy-turn',
        codexItemId: 'fork-transcript-legacy-prompt',
        ev: { t: 'text', text: `${codexRuntimeStatus}\n\n${legacyUserRequest}` },
    }];
    const beforeSessionId = await createE2ESession(request, {
        name: 'Fork transcript before regression',
        parentSessionId: 'fork-transcript-source',
        codexThreadId: 'fork-transcript-thread-before',
    });
    const afterSessionId = await createE2ESession(request, {
        name: 'Fork transcript after regression',
        parentSessionId: 'fork-transcript-source',
        codexThreadId: 'fork-transcript-thread-after',
    });

    try {
        await page.setViewportSize({ width: 1280, height: 720 });
        await appendE2ESessionEnvelopes(request, beforeSessionId, rawEnvelopes);
        await page.goto(authenticatedRoute(`/session/${beforeSessionId}`));

        await expect(page.getByText(internalPromptText, { exact: true })).toBeVisible({ timeout: 120_000 });
        await expect(page.getByText('AGENTS.md instructions', { exact: false })).toBeVisible();
        await expect(page.getByText(realUserRequest, { exact: true })).toBeVisible();
        await page.screenshot({
            path: forkTranscriptScreenshotPath(testInfo, 'before'),
            animations: 'disabled',
        });
        await pauseForRecordedReview(page, 1_100);

        await appendE2ESessionEnvelopes(request, afterSessionId, markedAndLegacyEnvelopes);
        await page.goto(authenticatedRoute(`/session/${afterSessionId}`));

        await expect(page.getByText(realUserRequest, { exact: true })).toBeVisible({ timeout: 120_000 });
        await expect(page.getByText(legacyUserRequest, { exact: true })).toBeVisible();
        await expect(page.getByText(codexRuntimeStatus, { exact: false })).toHaveCount(0);
        await expect(page.getByText('happy:system-prompt', { exact: false })).toHaveCount(0);
        await page.screenshot({
            path: forkTranscriptScreenshotPath(testInfo, 'after'),
            animations: 'disabled',
        });
        await pauseForRecordedReview(page, 1_100);
    } finally {
        await page.close();
    }
});

test('Web 启动不会使用已弃用的 pointerEvents 组件属性', async ({ page }) => {
    const deprecatedPointerEventsWarnings: string[] = [];
    page.on('console', (message) => {
        if (message.type() === 'warning' && message.text().includes('props.pointerEvents is deprecated')) {
            deprecatedPointerEventsWarnings.push(message.text());
        }
    });

    await page.goto(new URL('/new', authenticatedWebUrl).toString());
    await expect(page.getByRole('textbox')).toBeVisible();

    expect(deprecatedPointerEventsWarnings).toEqual([]);
});

test('Web 外观设置不会使用已弃用的 shadow 样式或 pointerEvents 组件属性', async ({ page }) => {
    const deprecatedShadowWarnings: string[] = [];
    const deprecatedPointerEventsWarnings: string[] = [];
    page.on('console', (message) => {
        if (message.type() === 'warning' && message.text().includes('"shadow*" style props are deprecated')) {
            deprecatedShadowWarnings.push(message.text());
        }
        if (message.type() === 'warning' && message.text().includes('props.pointerEvents is deprecated')) {
            deprecatedPointerEventsWarnings.push(message.text());
        }
    });

    await page.goto(new URL('/settings/appearance', authenticatedWebUrl).toString());
    await page.waitForFunction(() => document.querySelectorAll('[role="switch"]').length > 0);

    expect(deprecatedShadowWarnings).toEqual([]);
    expect(deprecatedPointerEventsWarnings).toEqual([]);
});

test('Web 弹窗不会触发已弃用样式、组件或原生动画警告', async ({ page }) => {
    const modalWarnings: string[] = [];
    page.on('console', (message) => {
        if (
            message.type() === 'warning'
            && (
                message.text().includes('"shadow*" style props are deprecated')
                || message.text().includes('TouchableWithoutFeedback is deprecated')
                || message.text().includes('useNativeDriver` is not supported')
            )
        ) {
            modalWarnings.push(message.text());
        }
    });

    await page.goto(authenticatedWebUrl);
    await expect(page.getByRole('textbox')).toBeVisible();
    await page.goto(new URL('/settings/account', authenticatedWebUrl).toString());
    await page.getByText('Logout', { exact: true }).click();
    await expect(page.getByText('Are you sure you want to logout?', { exact: false })).toBeVisible();
    await page.getByText('Cancel', { exact: true }).click();

    await page.goto(new URL('/dev/modal-demo', authenticatedWebUrl).toString());
    await page.getByText('Custom Modal', { exact: true }).first().click();
    const customModalMessage = page.getByText(
        'This is a completely custom modal component. You can put anything in here!',
        { exact: true },
    );
    await expect(customModalMessage).toBeVisible();
    await page.getByText('Custom Modal', { exact: true }).last().click();
    await expect(customModalMessage).toBeVisible();
    await page.mouse.click(10, 10);
    await expect(customModalMessage).toHaveCount(0);

    expect(modalWarnings).toEqual([]);
});

test('Web 深色命令面板跟随主题并支持完整关闭交互', async ({ page }) => {
    if (process.env.HAPPY_E2E_RECORD === '1') {
        test.setTimeout(120_000);
    }
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(new URL('/settings/appearance', authenticatedWebUrl).toString());
    await page.getByText('Terminal', { exact: true }).click();
    await page.goto(new URL('/settings/features', authenticatedWebUrl).toString());

    const featureSwitches = page.getByRole('switch');
    await expect(featureSwitches).toHaveCount(10);
    const commandPaletteSwitch = page.getByRole('switch', { name: 'Command Palette' });
    await expect(commandPaletteSwitch).toBeChecked();

    // A focused editor or embedded surface may stop bubbling at document.
    // The application shortcut must already have handled the key in capture.
    await page.evaluate(() => {
        document.addEventListener('keydown', (event) => {
            if ((event.metaKey || event.ctrlKey) && event.code === 'KeyP') {
                event.stopPropagation();
            }
        }, { once: true });
    });
    await page.keyboard.press('Meta+KeyP');
    const commandInput = page.getByTestId('command-palette-input');
    const palette = page.getByTestId('command-palette');
    await expect(commandInput).toBeVisible();
    await expect.poll(async () => Number(await palette.evaluate((node) => node.parentElement?.style.opacity ?? '0')))
        .toBeCloseTo(1, 2);
    await pauseForRecordedReview(page, 1_000);

    const paletteColors = await page.evaluate(() => {
        const input = document.querySelector('[data-testid="command-palette-input"]');
        const palette = document.querySelector('[data-testid="command-palette"]');
        const selected = document.querySelector('[data-testid="command-palette-item-new-session"]');
        if (!input || !palette || !selected) {
            throw new Error('找不到命令面板主题探针');
        }
        return {
            input: window.getComputedStyle(input).color,
            surface: window.getComputedStyle(palette).backgroundColor,
            selected: window.getComputedStyle(selected).backgroundColor,
        };
    });
    expect(paletteColors.input).toBe('rgb(229, 229, 231)');
    expect(paletteColors.surface).toBe('rgb(19, 19, 22)');
    expect(paletteColors.selected).toMatch(/\/ 0\.08\)$/);

    await commandInput.press('Escape');
    await expect(commandInput).toHaveCount(0);

    if (process.env.HAPPY_E2E_RECORD === '1') {
        await pauseForRecordedReview(page);
        return;
    }

    await page.goto(authenticatedWebUrl);
    await page.getByTestId('sidebar-command-palette-button').click();
    await expect(page.getByTestId('command-palette-input')).toBeVisible();
    await page.mouse.click(10, 10);
    await expect(page.getByTestId('command-palette-input')).toHaveCount(0);

    await page.goto(new URL('/settings/features', authenticatedWebUrl).toString());
    const reopenedCommandPaletteSwitch = page.getByRole('switch', { name: 'Command Palette' });
    await reopenedCommandPaletteSwitch.click();
    await expect(reopenedCommandPaletteSwitch).not.toBeChecked();

    await page.goto(new URL('/settings/appearance', authenticatedWebUrl).toString());
    await page.getByText('Caramel', { exact: true }).click();
});

test.describe('中文 Web 命令面板', () => {
    test.use({ locale: 'zh-CN' });

    test('静态命令、类别和空结果均完成本地化', async ({ page }, testInfo) => {
        await page.setViewportSize({ width: 2048, height: 982 });
        await page.goto(new URL('/settings/features', authenticatedWebUrl).toString());

        const commandPaletteSwitch = page.getByRole('switch', { name: '命令面板' });
        await expect(commandPaletteSwitch).toBeChecked();
        await page.goto(authenticatedWebUrl);
        await page.getByTestId('sidebar-command-palette-button').click();

        const commandInput = page.getByTestId('command-palette-input');
        const palette = page.getByTestId('command-palette');
        const selectedCommand = page.getByTestId('command-palette-item-new-session');
        await expect(commandInput).toHaveAttribute('placeholder', '输入命令或搜索...');
        await expect(palette.getByText('导航', { exact: true })).toBeVisible();
        await expect(selectedCommand.getByText('开始新会话', { exact: true })).toBeVisible();
        await expect(palette.getByText('配置应用偏好', { exact: true })).toBeVisible();
        await expect.poll(async () => Number(await palette.evaluate((node) => node.parentElement?.style.opacity ?? '0')))
            .toBeCloseTo(1, 2);
        await expect.poll(async () => (await palette.boundingBox())?.width).toBeCloseTo(720, 0);

        const selectedTitle = selectedCommand.getByText('开始新会话', { exact: true });
        const selectedSubtitle = selectedCommand.getByText('开始新的聊天会话', { exact: true });
        const [paletteMetrics, inputMetrics, selectedMetrics, titleFontSize, subtitleFontSize] = await Promise.all([
            palette.evaluate((node) => {
                const style = window.getComputedStyle(node);
                return {
                    borderRadius: style.borderRadius,
                    boxShadow: style.boxShadow,
                    width: node.getBoundingClientRect().width,
                    top: node.getBoundingClientRect().top,
                };
            }),
            commandInput.evaluate((node) => {
                const style = window.getComputedStyle(node);
                return {
                    fontSize: style.fontSize,
                    lineHeight: style.lineHeight,
                    paddingLeft: style.paddingLeft,
                    paddingTop: style.paddingTop,
                };
            }),
            selectedCommand.evaluate((node) => {
                const style = window.getComputedStyle(node);
                return {
                    borderWidth: style.borderWidth,
                    borderRadius: style.borderRadius,
                    height: node.getBoundingClientRect().height,
                };
            }),
            selectedTitle.evaluate((node) => window.getComputedStyle(node).fontSize),
            selectedSubtitle.evaluate((node) => window.getComputedStyle(node).fontSize),
        ] as const);

        expect(paletteMetrics.borderRadius).toBe('14px');
        expect(paletteMetrics.width).toBeCloseTo(720, 0);
        expect(paletteMetrics.boxShadow).not.toBe('none');
        expect(paletteMetrics.top).toBeCloseTo(176.75, 0);
        expect(inputMetrics).toEqual({
            fontSize: '16px',
            lineHeight: '22px',
            paddingLeft: '20px',
            paddingTop: '16px',
        });
        expect(selectedMetrics).toMatchObject({ borderWidth: '1px', borderRadius: '10px' });
        expect(selectedMetrics.height).toBeGreaterThanOrEqual(48);
        expect(selectedMetrics.height).toBeLessThanOrEqual(56);
        expect(titleFontSize).toBe('14px');
        expect(subtitleFontSize).toBe('12px');

        await page.screenshot({
            path: testInfo.outputPath('pc-command-palette-visual-after-2048x982.png'),
            fullPage: true,
        });

        await commandInput.fill('不会匹配任何命令的关键词');
        await expect(page.getByText('未找到命令', { exact: true })).toBeVisible();

        await commandInput.press('Escape');
        await expect(palette).toHaveCount(0);
        await page.goto(new URL('/settings/features', authenticatedWebUrl).toString());
        const cleanupSwitch = page.getByRole('switch', { name: '命令面板' });
        await cleanupSwitch.click();
        await expect(cleanupSwitch).not.toBeChecked();
    });
});

test('跨项目命令搜索显示可执行命令与会话元数据', async ({ page, request }, testInfo) => {
    const atlasSessionId = await createE2ESession(request, {
        path: '/workspace/atlas-web',
        host: 'studio-mac',
        name: 'Atlas release workspace',
        summary: 'Prepare Atlas release preview',
    });
    await createE2ESession(request, {
        path: '/workspace/beta-services',
        host: 'remote-linux',
        name: 'Beta service workspace',
        summary: 'Audit Beta service deployment',
        flavor: 'claude',
    });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(authenticatedWebUrl);
    await expect(page.getByText('Prepare Atlas release preview', { exact: true })).toBeVisible();

    await page.getByTestId('sidebar-command-palette-button').click();
    const commandInput = page.getByTestId('command-palette-input');
    await expect(commandInput).toBeFocused();
    await expect(commandInput).toHaveAttribute('role', 'combobox');
    await expect(commandInput).toHaveAttribute('aria-activedescendant', 'command-palette-option-new-session');
    await expect(page.getByRole('listbox')).toBeVisible();
    await expect(page.getByRole('option', { selected: true })).toHaveCount(1);

    await page.keyboard.press('Meta+KeyP');
    await page.keyboard.press('Meta+KeyP');
    await expect(page.getByTestId('command-palette')).toHaveCount(1);
    await expect(page.getByTestId('command-palette-item-open-project-folder')).toContainText('Folder');
    const searchFilesCommand = page.getByTestId('command-palette-item-search-project-files');
    await expect(searchFilesCommand).toContainText('Search Files');
    await searchFilesCommand.scrollIntoViewIfNeeded();
    await page.waitForTimeout(350); // Let the modal fade-in finish before visual evidence capture.
    await page.screenshot({
        path: testInfo.outputPath('pc-command-search-001-after-1280x900.png'),
        fullPage: true,
    });

    await commandInput.fill('atlas-web');
    const atlasResult = page.getByTestId(/command-palette-item-session-/).filter({
        hasText: 'Prepare Atlas release preview',
    });
    await expect(atlasResult).toBeVisible();
    await expect(atlasResult).toContainText('atlas-web');
    await expect(atlasResult).toContainText('studio-mac');
    await expect(atlasResult).toContainText('Codex');
    await expect(atlasResult).toContainText('Alt+1');
    await expect(atlasResult).toHaveAttribute('aria-selected', 'true');
    await expect(commandInput).toHaveAttribute('aria-activedescendant', await atlasResult.getAttribute('id') ?? '');
    await expect(atlasResult.getByTestId('command-palette-match').first()).toBeVisible();
    await page.screenshot({
        path: testInfo.outputPath('pc-command-search-002-after-1280x900.png'),
        fullPage: true,
    });

    await commandInput.fill('2026');
    await expect(commandInput).toHaveValue('2026');

    await commandInput.fill('atlas-web');
    await page.keyboard.press('Alt+Digit1');
    await expect(page).toHaveURL(new RegExp(`/session/${atlasSessionId}$`));
    await expect(page.getByTestId('session-message-input')).toBeVisible();

    await page.getByTestId('sidebar-command-palette-button').click();
    const sessionSearchFilesCommand = page.getByTestId('command-palette-item-search-project-files');
    await sessionSearchFilesCommand.click();
    await expect(page).toHaveURL(new RegExp(`/session/${atlasSessionId}/files\\?focus=search$`));
    await expect(page.getByPlaceholder('Search files...')).toBeFocused();
});

test('左栏稳定导航、机器项目分组与折叠共同保持当前会话可辨识', async ({ page, request }, testInfo) => {
    const atlasSessionId = await createE2ESession(request, {
        path: '/workspace/atlas',
        host: 'studio-mac',
        machineId: 'studio-machine',
        name: 'Atlas navigation refactor',
        summary: 'Keep the selected session visible',
    });
    await createE2ESession(request, {
        path: '/workspace/atlas',
        host: 'studio-mac',
        machineId: 'studio-machine',
        name: 'Atlas release notes',
    });
    const betaSessionId = await createE2ESession(request, {
        path: '/workspace/beta',
        host: 'studio-mac',
        machineId: 'studio-machine',
        name: 'Beta integration checks',
    });
    await createE2ESession(request, {
        path: '/srv/remote-ops',
        host: 'remote-linux',
        machineId: 'remote-machine',
        name: 'Remote operations audit',
    });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(authenticatedRoute(`/session/${atlasSessionId}`));
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);
    await expect(page.getByTestId(`session-row-${atlasSessionId}`)).toBeVisible();
    await expect(page.getByTestId('session-message-input')).toBeVisible();

    const primary = page.getByTestId('sidebar-primary-navigation');
    const newSession = primary.getByTestId('sidebar-new-session-button');
    const inbox = primary.getByTestId('sidebar-inbox-button');
    const sessionManagement = primary.getByTestId('sidebar-command-palette-button');
    const myAgents = page.getByTestId('sidebar-my-agents-button');
    await expect(newSession).toBeVisible();
    await expect(inbox).toBeVisible();
    await expect(sessionManagement).toBeVisible();
    await expect(myAgents).toBeVisible();
    const primaryOrder = await Promise.all([newSession, inbox, sessionManagement].map(async (item) => (
        await item.boundingBox()
    )?.y ?? -1));
    expect(primaryOrder[0]).toBeLessThan(primaryOrder[1]);
    expect(primaryOrder[1]).toBeLessThan(primaryOrder[2]);
    expect((await sessionManagement.boundingBox())!.y).toBeLessThan((await myAgents.boundingBox())!.y);

    const atlasRow = page.getByTestId(`session-row-${atlasSessionId}`);
    await expect(atlasRow).toHaveAttribute('aria-current', 'page');
    const betaToggle = page.getByTestId('sidebar-project-toggle-studio-machine--%2Fworkspace%2Fbeta');
    await expect(betaToggle).toHaveAttribute('aria-expanded', 'true');
    await betaToggle.click();
    await expect(betaToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId(`session-row-${betaSessionId}`)).toHaveCount(0);
    await page.waitForTimeout(350);

    await page.screenshot({
        path: testInfo.outputPath('navigation-ia-after-1280x900.png'),
        fullPage: true,
    });

    await page.goto(authenticatedRoute(`/session/${betaSessionId}`));
    await expect(page.getByTestId(`session-row-${betaSessionId}`)).toBeVisible();
    await expect(page.getByTestId(`session-row-${betaSessionId}`)).toHaveAttribute('aria-current', 'page');
    await expect(betaToggle).toHaveAttribute('aria-expanded', 'true');
});

test('[RELATIONSHIP-ADVISOR-HISTORY] 军师对话写入左栏且 PC Agent 使用紧凑弹层', async ({ page }, testInfo) => {
    const nestedButtonErrors: string[] = [];
    page.on('console', (message) => {
        const text = message.text();
        if (message.type() === 'error' && text.includes('cannot contain a nested')) nestedButtonErrors.push(text);
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(authenticatedRoute('/relationship-advisor'));

    const advisorComposer = page.getByRole('textbox', {
        name: 'Send what they said, a chat screenshot, or the reply you want to write',
    });
    const history = page.getByTestId('relationship-advisor-sidebar-history');
    await expect(advisorComposer).toBeVisible({ timeout: 20_000 });
    await expect(history).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get('conversationId')).not.toBeNull();
    const firstUrl = page.url();
    const firstId = new URL(firstUrl).searchParams.get('conversationId');
    expect(firstId).toBeTruthy();
    await expect(page.getByTestId(`relationship-advisor-history-${firstId}`)).toBeVisible();

    await page.reload();
    await expect(advisorComposer).toBeVisible();
    await expect(page).toHaveURL(firstUrl);
    await expect(page.getByTestId(`relationship-advisor-history-${firstId}`)).toBeVisible();

    await page.getByTestId('relationship-advisor-new-conversation').click();
    await expect.poll(() => new URL(page.url()).searchParams.get('conversationId')).not.toBe(firstId);
    const secondId = new URL(page.url()).searchParams.get('conversationId');
    expect(secondId).toBeTruthy();
    expect(secondId).not.toBe(firstId);
    await expect(page.getByTestId(`relationship-advisor-history-${secondId}`)).toBeVisible();
    await expect(history.locator('[data-testid^="relationship-advisor-history-"]')).toHaveCount(2);
    await pauseForRecordedReview(page, 1_000);

    const historyScreenshot = process.env.HAPPY_RELATIONSHIP_HISTORY_EVIDENCE_DIR
        ? path.join(process.env.HAPPY_RELATIONSHIP_HISTORY_EVIDENCE_DIR, 'case-1-after-history.png')
        : testInfo.outputPath('case-1-after-history.png');
    fs.mkdirSync(path.dirname(historyScreenshot), { recursive: true });
    await page.screenshot({ path: historyScreenshot, fullPage: true });

    const myAgentsButton = page.getByTestId('sidebar-my-agents-button');
    await myAgentsButton.click();
    const dialog = page.getByTestId('agent-sheet-desktop-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('xpath=ancestor::*[@role="dialog"]').first()).toBeVisible();
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox).not.toBeNull();
    expect(dialogBox!.width).toBeLessThanOrEqual(522);
    expect(dialogBox!.width).toBeLessThan(1280 * 0.6);
    expect(Math.abs((dialogBox!.x + dialogBox!.width / 2) - 640)).toBeLessThanOrEqual(2);
    expect(dialogBox!.y).toBeGreaterThan(80);
    expect(dialogBox!.y + dialogBox!.height).toBeLessThan(820);
    await pauseForRecordedReview(page, 1_100);

    const dialogScreenshot = process.env.HAPPY_RELATIONSHIP_HISTORY_EVIDENCE_DIR
        ? path.join(process.env.HAPPY_RELATIONSHIP_HISTORY_EVIDENCE_DIR, 'case-2-after-agent-dialog.png')
        : testInfo.outputPath('case-2-after-agent-dialog.png');
    fs.mkdirSync(path.dirname(dialogScreenshot), { recursive: true });
    await page.screenshot({ path: dialogScreenshot, fullPage: true });

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('role'))).not.toBe('dialog');

    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(authenticatedRoute('/settings/appearance'));
    await page.getByText('Gingham', { exact: true }).click();
    await expect.poll(() => page.locator('body').evaluate((element) => (
        window.getComputedStyle(element).backgroundColor
    ))).toBe('rgb(18, 24, 33)');

    const darkAdvisorUrl = new URL(authenticatedRoute('/relationship-advisor'));
    darkAdvisorUrl.searchParams.set('conversationId', secondId!);
    await page.goto(darkAdvisorUrl.toString());
    await expect(page.getByRole('textbox', {
        name: 'Send what they said, a chat screenshot, or the reply you want to write',
    })).toBeVisible({ timeout: 20_000 });
    const selectedHistoryRow = page.getByTestId(`relationship-advisor-history-${secondId}`);
    await expect(selectedHistoryRow).toBeVisible();
    await expect.poll(() => selectedHistoryRow.evaluate((element) => (
        window.getComputedStyle(element).backgroundColor
    ))).toBe('rgb(40, 53, 68)');

    const firstHistoryButton = page
        .getByTestId(`relationship-advisor-history-${firstId}`)
        .getByRole('button')
        .first();
    const firstHistoryButtonBox = await firstHistoryButton.boundingBox();
    expect(firstHistoryButtonBox).not.toBeNull();
    await page.mouse.move(
        firstHistoryButtonBox!.x + firstHistoryButtonBox!.width / 2,
        firstHistoryButtonBox!.y + firstHistoryButtonBox!.height / 2,
    );
    await page.mouse.down();
    await expect.poll(() => firstHistoryButton.evaluate((element) => (
        window.getComputedStyle(element).backgroundColor
    ))).toBe('rgb(31, 42, 56)');

    const darkHistoryScreenshot = process.env.HAPPY_RELATIONSHIP_HISTORY_EVIDENCE_DIR
        ? path.join(process.env.HAPPY_RELATIONSHIP_HISTORY_EVIDENCE_DIR, 'case-1-after-history-gingham-dark.png')
        : testInfo.outputPath('case-1-after-history-gingham-dark.png');
    fs.mkdirSync(path.dirname(darkHistoryScreenshot), { recursive: true });
    await page.screenshot({ path: darkHistoryScreenshot, fullPage: true });
    await page.mouse.up();

    await page.getByTestId('sidebar-my-agents-button').click();
    const darkDialog = page.getByTestId('agent-sheet-desktop-dialog');
    await expect(darkDialog).toBeVisible();
    await expect.poll(() => darkDialog.evaluate((element) => (
        window.getComputedStyle(element).backgroundColor
    ))).toBe('rgb(26, 35, 48)');
    const darkDialogScreenshot = process.env.HAPPY_RELATIONSHIP_HISTORY_EVIDENCE_DIR
        ? path.join(process.env.HAPPY_RELATIONSHIP_HISTORY_EVIDENCE_DIR, 'case-2-after-agent-dialog-gingham-dark.png')
        : testInfo.outputPath('case-2-after-agent-dialog-gingham-dark.png');
    fs.mkdirSync(path.dirname(darkDialogScreenshot), { recursive: true });
    await page.screenshot({ path: darkDialogScreenshot, fullPage: true });

    await page.keyboard.press('Escape');
    await expect(darkDialog).toHaveCount(0);
    expect(nestedButtonErrors).toEqual([]);
});

test('[SESSION-ARCHIVE-STATUS] 当前项目状态常驻且归档会话保持紧凑', async ({ page, request }, testInfo) => {
    test.slow();
    const fixtureKey = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const machineId = `visual-mac-mini-${fixtureKey}`;
    const projectPath = `/workspace/session-status-${fixtureKey}`;
    const activeSessionId = await createE2ESession(request, {
        path: projectPath,
        host: 'mac-mini',
        machineId,
        homeDir: '/workspace',
        name: 'Current Mac progress status',
    });
    const archivedSessionId = await createE2ESession(request, {
        agentState: {
            turnStatus: {
                status: 'completed',
                updatedAt: Date.now(),
                turnId: `turn-completed-${fixtureKey}`,
            },
        },
        path: projectPath,
        host: 'mac-mini',
        machineId,
        homeDir: '/workspace',
        name: 'Archived compact session row',
    });
    const authToken = new URL(authenticatedWebUrl).searchParams.get('dev_token');
    if (!authToken) throw new Error('缺少会话状态视觉验收所需的本地认证配置。');
    const cleanupHeaders = {
        Authorization: `Bearer ${authToken}`,
        'X-Happy-Client': 'playwright-session-status',
    };

    try {
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto(authenticatedRoute(`/session/${activeSessionId}`));
        await expect(page.getByTestId('session-message-input')).toBeVisible();

        const projectKey = `${encodeURIComponent(machineId)}--${encodeURIComponent(projectPath)}`;
        const projectToggle = page.getByTestId(`sidebar-project-toggle-${projectKey}`);
        const projectContainer = page.getByTestId(`sidebar-project-toggle-${projectKey}-container`);
        const projectStatus = page.getByTestId(`sidebar-project-toggle-${projectKey}-status`);
        const activeSessionRow = page.getByTestId(`session-row-${activeSessionId}`);
        await expect(projectToggle).toBeVisible();
        await expect(projectToggle).toHaveAttribute('aria-expanded', 'true');
        await expect(activeSessionRow).toHaveAttribute('aria-current', 'page');

        if (sessionStatusEvidencePhase === 'before') {
            await expect(projectStatus).toHaveCount(0);
            await expect(activeSessionRow.getByTestId('session-row-status')).toHaveCount(0);
        } else {
            await expect(projectStatus).toContainText(/idle/i);
            await expect(activeSessionRow.getByTestId('session-row-status')).toContainText(/idle/i);
        }
        await pauseForRecordedReview(page, 1_000);
        await projectContainer.screenshot({ path: sessionStatusScreenshotPath(testInfo, 1) });

        let archivedSessionRow = page.getByTestId(`session-row-${archivedSessionId}`);
        await archivedSessionRow.hover();
        await pauseForRecordedReview(page, 1_000);
        await page.getByTestId(`session-row-actions-${archivedSessionId}`)
            .getByTestId('session-row-archive-action')
            .click();
        const deactivateResponse = await request.post(
            new URL(`/v1/sessions/${encodeURIComponent(archivedSessionId)}/archive`, e2eServerUrl).toString(),
            { headers: cleanupHeaders },
        );
        expect(deactivateResponse.ok()).toBe(true);
        await page.reload();
        await expect(page.getByTestId('session-message-input')).toBeVisible();
        const archiveToggle = page.getByTestId('session-archive-toggle');
        await expect(archiveToggle).toBeVisible();
        await archiveToggle.scrollIntoViewIfNeeded();
        if ((await archiveToggle.textContent())?.includes('Show archived')) {
            await archiveToggle.click();
        }
        archivedSessionRow = page.getByTestId(`session-row-${archivedSessionId}`);
        await expect(archivedSessionRow).toBeVisible();
        await archivedSessionRow.scrollIntoViewIfNeeded();
        const archivedRowSurface = archivedSessionRow.locator('..');
        const archivedRowBox = await archivedRowSurface.boundingBox();
        if (!archivedRowBox) throw new Error('无法测量归档会话行。');

        if (sessionStatusEvidencePhase === 'before') {
            expect(archivedRowBox.height).toBeGreaterThanOrEqual(80);
        } else {
            expect(archivedRowBox.height).toBeLessThan(80);
            const archivedStatus = archivedSessionRow.getByTestId('session-row-status');
            await expect(archivedStatus).toContainText(/completed.*disconnected/i);
            await expect(archivedStatus.getByText(/completed.*disconnected/i)).toHaveCSS('color', 'rgb(52, 199, 89)');
        }
        await pauseForRecordedReview(page, 2_000);
        await archivedRowSurface.screenshot({ path: sessionStatusScreenshotPath(testInfo, 2) });
    } finally {
        for (const sessionId of [activeSessionId, archivedSessionId]) {
            await request.post(
                new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/archive`, e2eServerUrl).toString(),
                { headers: cleanupHeaders },
            );
            const deleteResponse = await request.delete(
                new URL(`/v1/sessions/${encodeURIComponent(sessionId)}`, e2eServerUrl).toString(),
                { headers: cleanupHeaders },
            );
            expect(deleteResponse.ok()).toBe(true);
        }
    }
});

test('[R10-04] 高密度导航在搜索、归档和深链刷新后保持稳定', async ({ page, request }) => {
    test.slow();
    const fixtureKey = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const machineIds = Array.from({ length: 3 }, (_, index) => `r10-machine-${index + 1}-${fixtureKey}`);
    const projects = Array.from({ length: 10 }, (_, projectIndex) => ({
        machineId: machineIds[projectIndex % machineIds.length]!,
        path: `/workspace/r10-${fixtureKey}/project-${String(projectIndex + 1).padStart(2, '0')}`,
        projectIndex,
    }));
    const sessions: Array<{
        id: string;
        machineId: string;
        path: string;
        projectIndex: number;
        summary: string;
    }> = [];
    const authToken = new URL(authenticatedWebUrl).searchParams.get('dev_token');
    if (!authToken) throw new Error('缺少高密度导航 E2E 所需的本地认证配置。');
    const cleanupHeaders = {
        Authorization: `Bearer ${authToken}`,
        'X-Happy-Client': 'playwright-r10-navigation',
    };

    try {
        for (const project of projects) {
            const creationResults = await Promise.allSettled(
                Array.from({ length: 5 }, async (_, sessionIndex) => {
                    const summary = `R10 ${fixtureKey} project ${project.projectIndex + 1} session ${sessionIndex + 1}`;
                    const id = await createE2ESession(request, {
                        path: project.path,
                        host: project.machineId,
                        machineId: project.machineId,
                        name: summary,
                        summary,
                    });
                    return { ...project, id, summary };
                }),
            );
            for (const result of creationResults) {
                if (result.status === 'fulfilled') sessions.push(result.value);
            }
            const failure = creationResults.find(result => result.status === 'rejected');
            if (failure?.status === 'rejected') throw failure.reason;
        }

        expect(machineIds).toHaveLength(3);
        expect(projects).toHaveLength(10);
        expect(sessions).toHaveLength(50);

        const searchTarget = sessions[17]!;
        const archiveTarget = sessions[28]!;
        const deepLinkTarget = sessions[47]!;
        const disconnectedTarget = sessions[8]!;
        const disconnectResponse = await request.post(
            new URL(`/v1/sessions/${encodeURIComponent(disconnectedTarget.id)}/archive`, e2eServerUrl).toString(),
            {
                headers: cleanupHeaders,
            },
        );
        expect(disconnectResponse.ok()).toBe(true);

        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto(authenticatedRoute('/new'));
        await expect(page.getByRole('textbox')).toBeVisible();
        const archiveToggle = page.getByTestId('session-archive-toggle');

        for (const machineId of machineIds) {
            await expect(page.getByText(machineId, { exact: true })).toBeVisible();
        }
        for (const project of projects) {
            const projectKey = `${encodeURIComponent(project.machineId)}--${encodeURIComponent(project.path)}`;
            const toggle = page.getByTestId(`sidebar-project-toggle-${projectKey}`);
            const projectSessions = sessions.filter(session => session.projectIndex === project.projectIndex);
            const rows = page.getByTestId(`sidebar-project-sessions-${projectKey}`);
            expect(projectSessions).toHaveLength(5);
            await expect(toggle).toBeVisible();
            await expect(toggle).toHaveAttribute('aria-expanded', 'true');
            for (const session of projectSessions) {
                await expect(rows.getByTestId(`session-row-${session.id}`)).toBeVisible();
            }
        }

        const activeStatus = page
            .getByTestId(`session-row-${searchTarget.id}`)
            .getByTestId('session-row-status');
        await expect(activeStatus).toBeVisible();
        await expect(activeStatus).toHaveText(/\S/);

        const disconnectedRow = page.getByTestId(`session-row-${disconnectedTarget.id}`);
        await expect(disconnectedRow).toHaveAccessibleName(/disconnected/i);
        await expect(disconnectedRow.getByTestId('session-row-status')).toContainText(/disconnected/i);
        await disconnectedRow.scrollIntoViewIfNeeded();
        await disconnectedRow.hover();
        await expect(page.getByTestId('session-row-details')).toContainText(/disconnected/i);

        await page.getByTestId('sidebar-command-palette-button').click();
        const commandInput = page.getByTestId('command-palette-input');
        await commandInput.fill(searchTarget.summary);
        const searchResult = page.getByTestId(`command-palette-item-session-${searchTarget.id}`);
        await expect(searchResult).toBeVisible();
        await expect(searchResult).toContainText(searchTarget.path);
        await expect(searchResult).toContainText(searchTarget.machineId);

        const impossibleQuery = `r10-no-result-${fixtureKey}`;
        await commandInput.fill(impossibleQuery);
        await expect(page.getByText('No commands found', { exact: true })).toBeVisible();
        await commandInput.press('Escape');
        await expect(page.getByTestId('command-palette')).toHaveCount(0);

        let archiveRow = page.getByTestId(`session-row-${archiveTarget.id}`);
        await archiveRow.scrollIntoViewIfNeeded();
        await archiveRow.hover();
        await page.getByTestId(`session-row-actions-${archiveTarget.id}`)
            .getByTestId('session-row-archive-action')
            .click();
        await expect(archiveToggle).toContainText(/Show archived|Hide archived/);
        if ((await archiveToggle.textContent())?.includes('Hide archived')) {
            await archiveToggle.click();
        }
        await expect(archiveToggle).toContainText('Show archived');
        await expect(archiveRow).toHaveCount(0);

        await archiveToggle.click();
        archiveRow = page.getByTestId(`session-row-${archiveTarget.id}`);
        await expect(archiveRow).toBeVisible();
        await expect(archiveRow.getByTestId('session-row-status')).toBeVisible();
        const archivedRowBox = await archiveRow.boundingBox();
        expect(archivedRowBox?.height).toBeLessThan(80);
        await archiveRow.scrollIntoViewIfNeeded();
        await archiveRow.hover();
        const restoreAction = page.getByTestId(`session-row-actions-${archiveTarget.id}`)
            .getByTestId('session-row-restore-action');
        await expect(restoreAction).toHaveAccessibleName('Restore Session');
        await restoreAction.click();

        const restoredRow = page.getByTestId(`session-row-${archiveTarget.id}`);
        await expect(restoredRow).toBeVisible();

        const deepLinkProjectKey = `${encodeURIComponent(deepLinkTarget.machineId)}--${encodeURIComponent(deepLinkTarget.path)}`;
        const deepLinkToggle = page.getByTestId(`sidebar-project-toggle-${deepLinkProjectKey}`);
        await deepLinkToggle.scrollIntoViewIfNeeded();
        await deepLinkToggle.click();
        await expect(deepLinkToggle).toHaveAttribute('aria-expanded', 'false');
        await expect(page.getByTestId(`session-row-${deepLinkTarget.id}`)).toHaveCount(0);

        await page.goto(authenticatedRoute(`/session/${deepLinkTarget.id}`));
        const deepLinkRow = page.getByTestId(`session-row-${deepLinkTarget.id}`);
        await expect(page.getByTestId('session-message-input')).toBeVisible();
        await expect(deepLinkToggle).toHaveAttribute('aria-expanded', 'true');
        await expect(deepLinkRow).toBeVisible();
        await expect(deepLinkRow).toHaveAttribute('aria-current', 'page');
        await expect(page.getByTestId(`sidebar-project-toggle-${deepLinkProjectKey}-status`)).toHaveText(/\S/);

        await page.reload();
        await expect(page.getByTestId('session-message-input')).toBeVisible();
        await expect(deepLinkToggle).toHaveAttribute('aria-expanded', 'true');
        await expect(deepLinkRow).toBeVisible();
        await expect(deepLinkRow).toHaveAttribute('aria-current', 'page');
    } finally {
        for (let index = 0; index < sessions.length; index += 5) {
            await Promise.all(sessions.slice(index, index + 5).map(async ({ id }) => {
                const archiveResponse = await request.post(
                    new URL(`/v1/sessions/${encodeURIComponent(id)}/archive`, e2eServerUrl).toString(),
                    { headers: cleanupHeaders },
                );
                expect(archiveResponse.ok()).toBe(true);
                const deleteResponse = await request.delete(
                    new URL(`/v1/sessions/${encodeURIComponent(id)}`, e2eServerUrl).toString(),
                    { headers: cleanupHeaders },
                );
                expect(deleteResponse.ok()).toBe(true);
            }));
        }
    }
});

test('[SESSION-LAYOUT] 左栏在项目分组与时间排序之间切换并记住选择', async ({ page, request }, testInfo) => {
    const oldestSessionId = await createE2ESession(request, {
        path: '/workspace/atlas',
        host: 'studio-mac',
        machineId: 'studio-machine',
        homeDir: '/workspace',
        name: 'Atlas dependency review',
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const middleSessionId = await createE2ESession(request, {
        path: '/workspace/beta',
        host: 'studio-mac',
        machineId: 'studio-machine',
        homeDir: '/workspace',
        name: 'Beta integration checks',
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const newestSessionId = await createE2ESession(request, {
        path: '/workspace/atlas',
        host: 'studio-mac',
        machineId: 'studio-machine',
        homeDir: '/workspace',
        name: 'Atlas navigation polish',
    });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(authenticatedRoute(`/session/${newestSessionId}`));
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);

    const layoutToggle = page.getByTestId('session-list-layout-toggle');
    const layoutIcon = page.getByTestId('session-list-layout-toggle-icon');
    const projectScreenshot = testInfo.outputPath('session-list-project-layout-1280x900.png');
    const timeScreenshot = testInfo.outputPath('session-list-time-layout-1280x900.png');

    await expect(layoutToggle).toHaveAccessibleName('Sort sessions by time');
    await expect(layoutIcon).toHaveAttribute('data-icon-name', 'clock');
    await expect(page.getByTestId('sidebar-project-toggle-studio-machine--%2Fworkspace%2Fatlas')).toBeVisible();
    await expect(page.getByTestId('sidebar-project-toggle-studio-machine--%2Fworkspace%2Fbeta')).toBeVisible();
    await page.screenshot({ path: projectScreenshot, fullPage: true });

    await layoutToggle.hover();
    await expect(page.getByTestId('session-list-layout-tooltip')).toHaveText('Sort sessions by time');
    await layoutToggle.click();

    await expect(layoutToggle).toHaveAccessibleName('Group sessions by project');
    await expect(layoutIcon).toHaveAttribute('data-icon-name', 'folder');
    await expect(page.getByTestId('session-list-layout-tooltip')).toHaveText('Group sessions by project');
    await expect(page.getByTestId('session-time-group-0')).toBeVisible();
    await expect(page.getByTestId('sidebar-project-toggle-studio-machine--%2Fworkspace%2Fatlas')).toHaveCount(0);
    await expect(page.getByTestId(`session-row-${newestSessionId}`)).toContainText('~/atlas · studio-machine');
    await expect(page.getByTestId(`session-row-${middleSessionId}`)).toContainText('~/beta · studio-machine');

    const recencyOrder = await Promise.all([
        newestSessionId,
        middleSessionId,
        oldestSessionId,
    ].map(async (sessionId) => (await page.getByTestId(`session-row-${sessionId}`).boundingBox())?.y ?? -1));
    expect(recencyOrder[0]).toBeGreaterThan(0);
    expect(recencyOrder[0]).toBeLessThan(recencyOrder[1]);
    expect(recencyOrder[1]).toBeLessThan(recencyOrder[2]);
    await page.screenshot({ path: timeScreenshot, fullPage: true });

    await page.reload();
    await expect(page.getByTestId('session-time-group-0')).toBeVisible();
    await expect(layoutIcon).toHaveAttribute('data-icon-name', 'folder');
    await layoutToggle.click();
    await expect(page.getByTestId('sidebar-project-toggle-studio-machine--%2Fworkspace%2Fatlas')).toBeVisible();
    await expect(layoutIcon).toHaveAttribute('data-icon-name', 'clock');
    await page.reload();
    await expect(page.getByTestId('sidebar-project-toggle-studio-machine--%2Fworkspace%2Fatlas')).toBeVisible();
});

test('[PROJECT-HOVER-ACTIONS] PC 项目行悬浮仅显示新建会话操作', async ({ page, request }, testInfo) => {
    const sessionId = await createE2ESession(request, {
        path: '/workspace/console',
        host: 'studio-mac',
        machineId: 'studio-machine',
        homeDir: '/workspace',
        name: 'Console hover actions',
    });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(authenticatedRoute(`/session/${sessionId}`));
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);

    const project = page.getByTestId('sidebar-project-toggle-studio-machine--%2Fworkspace%2Fconsole');
    const projectActions = page.getByTestId('sidebar-project-toggle-studio-machine--%2Fworkspace%2Fconsole-actions');
    await expect(project).toBeVisible();
    await project.hover();

    if (projectHoverEvidencePhase === 'before') {
        await expect(projectActions).toBeVisible();
        await expect(page.getByTestId('sidebar-project-toggle-studio-machine--%2Fworkspace%2Fconsole-more-action'))
            .toBeVisible();
    } else {
        await expect(projectActions).toBeVisible();
        await expect(page.getByTestId('sidebar-project-toggle-studio-machine--%2Fworkspace%2Fconsole-more-action'))
            .toHaveCount(0);
        await expect(page.getByTestId('sidebar-project-toggle-studio-machine--%2Fworkspace%2Fconsole-new-session-action'))
            .toHaveAccessibleName('New session');
        await expect(page.getByTestId('sidebar-project-toggle-studio-machine--%2Fworkspace%2Fconsole-new-session-action').locator('[data-icon-name="edit-3"]'))
            .toHaveCount(1);
    }
    await page.screenshot({ path: projectHoverScreenshotPath(testInfo), fullPage: true });

    if (projectHoverEvidencePhase !== 'before') {
        await project.click({ button: 'right' });
        await expect(page.getByText('Pin Session', { exact: true })).toBeVisible();
        await page.mouse.click(1000, 850);
        await expect(page.getByText('Pin Session', { exact: true })).toHaveCount(0);

        await project.hover();
        await page.getByTestId('sidebar-project-toggle-studio-machine--%2Fworkspace%2Fconsole-new-session-action').click();
        await expect(page).toHaveURL((url) => url.pathname === '/new');
        await expect(page.locator('[data-testid="new-session-message-input"]:visible')).toBeVisible();
    }
});

test('[PC-TITLE-TOOLTIP] PC 标题悬浮和聚焦不再重复显示标题提示', async ({ page, request }, testInfo) => {
    const userPrompt = '这是一条真实用户消息，必须继续显示。';
    const sessionId = await createE2ESession(request, {
        summary: 'PC 标题不再重复提示',
        name: 'Desktop title-tooltip regression',
    });
    await createE2EUserMessage(request, sessionId, {
        text: userPrompt,
        model: 'gpt-5.6-sol',
        effort: 'high',
        permission: 'default',
    });

    await page.setViewportSize({ width: 1496, height: 768 });
    await page.goto(authenticatedRoute(`/session/${sessionId}`));
    const title = page.locator('[data-testid="session-header-title"]:visible');
    await expect(title).toHaveText('PC 标题不再重复提示');
    await title.hover();
    if (titleTooltipEvidencePhase === 'before') {
        await expect(page.getByTestId('session-header-title-tooltip')).toBeVisible();
        await pauseForRecordedReview(page, 1_000);
        await page.screenshot({
            path: titleTooltipScreenshotPath(testInfo),
            fullPage: true,
        });
        return;
    }
    await expect(page.getByTestId('session-header-title-tooltip')).toHaveCount(0);
    await expect(page.getByText(userPrompt, { exact: true })).toBeVisible();
    await pauseForRecordedReview(page, 1_000);
    await page.screenshot({
        path: titleTooltipScreenshotPath(testInfo),
        fullPage: true,
    });

    await title.focus();
    await expect(page.getByTestId('session-header-title-tooltip')).toHaveCount(0);
});

test('[R10-01] 每轮权限、模型与推理强度经 UI 发送并在离线重连后保持一致', async ({ page, request }, testInfo) => {
    const fixture = await createConnectedE2EComposerModeSession(request);
    const sessionId = fixture.sessionId;
    const historicalMessage = 'Historical turn used the previous runtime configuration.';
    await createE2EUserMessage(request, sessionId, {
        text: historicalMessage,
        model: 'gpt-5.5',
        effort: 'medium',
        permission: 'acceptEdits',
    });

    try {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(authenticatedRoute(`/session/${sessionId}`));
        expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);
        await expect(page.getByTestId('session-message-input')).toBeVisible({ timeout: 120_000 });
        await expect(page.locator('[data-testid="message-composer-send-button"]:visible')).toHaveCount(1);
        await expect(page.getByTestId('session-composer-mode-selector')).toHaveCount(0);
        await expect(page.getByTestId('session-composer-permission-selector')).toHaveCount(0);
        await page.screenshot({
            path: testInfo.outputPath('mobile-composer-mode-001-after-390x844.png'),
            fullPage: true,
        });

        await page.setViewportSize({ width: 1280, height: 900 });

        const selector = page.locator('[data-testid="session-composer-mode-selector"]:visible');
        const permissionSelector = page.locator('[data-testid="session-composer-permission-selector"]:visible');
        const permissionTrigger = permissionSelector.getByTestId('session-composer-permission-trigger');
        const modelTrigger = selector.getByTestId('session-composer-model-trigger');
        const effortTrigger = selector.getByTestId('session-composer-effort-trigger');
        await expect(permissionSelector).toBeVisible();
        await expect(permissionTrigger).toContainText('Ask first');
        await expect(permissionTrigger).toHaveAttribute('aria-label', 'Permissions: Needs confirmation');
        await expect(permissionTrigger).toHaveAttribute('aria-expanded', 'false');
        await expect(selector).toBeVisible();
        await expect(modelTrigger).toContainText('gpt-5.6-sol');
        await expect(modelTrigger).toHaveAttribute('aria-label', 'MODEL: gpt-5.6-sol');
        await expect(effortTrigger).toContainText('xhigh');
        await expect(effortTrigger).toHaveAttribute('aria-label', 'EFFORT: xhigh');
        const fastToggle = selector.getByTestId('session-composer-fast-toggle');
        await expect(fastToggle).toBeVisible();
        await expect(fastToggle).toHaveAttribute('role', 'switch');
        await expect(fastToggle).toHaveAttribute('aria-label', 'Fast');
        await expect(fastToggle).not.toContainText('Fast');
        await expect(fastToggle).toHaveAttribute('aria-checked', 'false');
        await fastToggle.click();
        await expect(fastToggle).toHaveAttribute('aria-checked', 'true');

        await expect(page.getByText(historicalMessage, { exact: true })).toBeVisible();
        const historicalModeLabel = page.getByTestId(/^message-user-mode-/).filter({
            hasText: 'Needs confirmation · gpt-5.5 · medium',
        });
        await expect(historicalModeLabel).toHaveCount(1);
        await expect(historicalModeLabel).toHaveText('Needs confirmation · gpt-5.5 · medium');
        await page.screenshot({
            path: testInfo.outputPath('pc-composer-fast-001-after-1280x900.png'),
            fullPage: true,
        });

        await permissionTrigger.click();
        const permissionPicker = page.getByTestId('session-composer-permission-picker');
        const confirmPermission = page.getByTestId('session-composer-permission-option-confirm');
        const fullAccessPermission = page.getByTestId('session-composer-permission-option-full-access');
        await expect(permissionPicker).toBeVisible();
        await expect(permissionTrigger).toHaveAttribute('aria-expanded', 'true');
        await expect(confirmPermission).toBeChecked();
        await expect(fullAccessPermission).not.toBeChecked();
        await expect(permissionPicker.getByText(
            'Uses the agent confirmation flow for actions that need extra permission. Device and outer sandbox limits still apply.',
            { exact: true },
        )).toBeVisible();
        await expect(permissionPicker.getByText(
            'Bypasses agent confirmations where supported. Device and outer sandbox limits still apply.',
            { exact: true },
        )).toBeVisible();
        await page.waitForTimeout(350); // Let the picker fade-in finish before visual evidence capture.
        await page.screenshot({
            path: testInfo.outputPath('pc-composer-permission-001-after-1280x900.png'),
            fullPage: true,
        });

        await fullAccessPermission.click();
        await expect(page.getByText('Enable full access?', { exact: true })).toBeVisible();
        await expect(page.getByText(
            'Full access bypasses agent confirmations where supported, including for potentially high-risk actions. It does not override device or outer sandbox limits. Only continue if you trust this task.',
            { exact: true },
        )).toBeVisible();
        await page.waitForTimeout(350); // Let the risk modal fade-in finish before visual evidence capture.
        await page.screenshot({
            path: testInfo.outputPath('pc-composer-permission-002-after-1280x900.png'),
            fullPage: true,
        });
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(page.getByText('Enable full access?', { exact: true })).toHaveCount(0);
        await expect(permissionTrigger).toContainText('Ask first');
        await expect(permissionTrigger).toBeFocused();

        await permissionTrigger.click();
        await page.getByTestId('session-composer-permission-option-full-access').click();
        await expect(page.getByText('Enable full access?', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Enable full access', exact: true }).click();
        await expect(permissionTrigger).toContainText('Full');
        await expect(permissionTrigger).toHaveAttribute('aria-label', 'Permissions: Full access');
        await expect(historicalModeLabel).toHaveText('Needs confirmation · gpt-5.5 · medium');
        await page.screenshot({
            path: testInfo.outputPath('pc-composer-permission-003-after-1280x900.png'),
            fullPage: true,
        });

        await permissionTrigger.click();
        await page.getByTestId('session-composer-permission-option-confirm').click();
        await expect(permissionTrigger).toContainText('Ask first');
        await permissionTrigger.click();
        await page.getByTestId('session-composer-permission-option-full-access').click();
        await expect(page.getByText('Enable full access?', { exact: true })).toHaveCount(0);
        await expect(permissionTrigger).toContainText('Full');
        await expect(historicalModeLabel).toHaveText('Needs confirmation · gpt-5.5 · medium');
        await page.screenshot({
            path: testInfo.outputPath('pc-composer-permission-004-after-1280x900.png'),
            fullPage: true,
        });

        await modelTrigger.click();
        const modelPicker = page.getByTestId('session-composer-model-picker');
        await expect(modelPicker).toBeVisible();
        await expect(modelTrigger).toHaveAttribute('aria-expanded', 'true');
        await expect(modelPicker.getByRole('radio', { name: 'default model' })).toBeVisible();
        await expect(modelPicker.getByRole('radio', { name: /^gpt-5\.5,/ })).toBeVisible();
        await expect(modelPicker.getByRole('radio', { name: /^gpt-5\.6-sol,/ })).toBeChecked();
        await page.waitForTimeout(350); // Let the picker fade-in finish before visual evidence capture.
        await page.screenshot({
            path: testInfo.outputPath('pc-composer-mode-002-after-1280x900.png'),
            fullPage: true,
        });

        await page.getByTestId('session-composer-mode-picker-scrim').click({ position: { x: 8, y: 8 } });
        await expect(modelPicker).toHaveCount(0);
        await expect(modelTrigger).toHaveAttribute('aria-expanded', 'false');

        await effortTrigger.click();
        const effortPicker = page.getByTestId('session-composer-effort-picker');
        await expect(effortPicker).toBeVisible();
        await expect(effortTrigger).toHaveAttribute('aria-expanded', 'true');
        await expect(effortPicker.getByRole('radio', { name: 'default effort' })).toBeVisible();
        await expect(effortPicker.getByRole('radio', { name: /^medium,/ })).toBeVisible();
        await expect(effortPicker.getByRole('radio', { name: /^high,/ })).toBeVisible();
        await expect(effortPicker.getByRole('radio', { name: /^xhigh,/ })).toBeChecked();

        await effortPicker.getByRole('radio', { name: /^high,/ }).click();
        await expect(effortTrigger).toContainText('high');
        await modelTrigger.click();
        await page.getByTestId('session-composer-model-picker')
            .getByRole('radio', { name: /^gpt-5\.5,/ })
            .click();
        await expect(modelTrigger).toContainText('gpt-5.5');
        await expect(permissionTrigger).toContainText('Full');

        const sentMessage = `UI metadata regression ${Date.now()}`;
        const input = page.getByTestId('session-message-input');
        await input.fill(sentMessage);
        await page.locator('[data-testid="message-composer-send-button"]:visible').click();
        await expect(page.getByText(sentMessage, { exact: true })).toBeVisible();
        await expect.poll(async () => {
            const record = await readE2EUserMessage(request, sessionId, sentMessage);
            const meta = record?.meta as Record<string, unknown> | undefined;
            return JSON.stringify({
                sentFrom: meta?.sentFrom,
                permissionMode: meta?.permissionMode,
                permissionModeExplicit: meta?.permissionModeExplicit,
                model: meta?.model,
                effort: meta?.effort,
            });
        }, { timeout: 10_000 }).toBe(JSON.stringify({
            sentFrom: 'web',
            permissionMode: 'yolo',
            permissionModeExplicit: true,
            model: 'gpt-5.5',
            effort: 'high',
        }));

        await fixture.client.goOffline();
        await expect(permissionTrigger).toHaveAttribute('aria-disabled', 'true');
        await expect(modelTrigger).toHaveAttribute('aria-disabled', 'true');
        await expect(effortTrigger).toHaveAttribute('aria-disabled', 'true');
        await expect(page.getByTestId('session-composer-permission-disabled-reason')).toHaveCount(0);
        await expect(page.getByTestId('session-composer-disabled-reason')).toHaveCount(0);
        await expect(permissionTrigger).toContainText('Full');
        await expect(modelTrigger).toContainText('gpt-5.5');
        await expect(effortTrigger).toContainText('high');
        await page.screenshot({
            path: testInfo.outputPath('pc-composer-offline-single-notice-after-1280x900.png'),
            fullPage: true,
        });

        await fixture.client.reconnect();
        await expect(permissionTrigger).not.toHaveAttribute('aria-disabled', 'true');
        await expect(modelTrigger).not.toHaveAttribute('aria-disabled', 'true');
        await expect(effortTrigger).not.toHaveAttribute('aria-disabled', 'true');
        await expect(page.getByTestId('session-composer-permission-disabled-reason')).toHaveCount(0);
        await expect(page.getByTestId('session-composer-disabled-reason')).toHaveCount(0);
        await expect(permissionTrigger).toContainText('Full');
        await expect(modelTrigger).toContainText('gpt-5.5');
        await expect(effortTrigger).toContainText('high');
        await expect(historicalModeLabel).toHaveText('Needs confirmation · gpt-5.5 · medium');
    } finally {
        await fixture.client.close();
    }
});

test('Web 账户页不会让用户触发不支持的推送重新注册', async ({ page }) => {
    await page.goto(authenticatedWebUrl);
    await expect(page.getByRole('textbox')).toBeVisible();
    await page.goto(new URL('/settings/account', authenticatedWebUrl).toString());
    await expect(page.getByText('Unavailable', { exact: true })).toBeVisible();

    const reRegisterAction = page.getByText('Re-register This Device', { exact: true });
    const isDisabled = await reRegisterAction.evaluate((element) => {
        let current: HTMLElement | null = element as HTMLElement;
        while (current) {
            if (
                current.getAttribute('aria-disabled') === 'true'
                || ('disabled' in current && (current as HTMLButtonElement).disabled)
            ) {
                return true;
            }
            current = current.parentElement;
        }
        return false;
    });
    expect(isDisabled).toBe(true);

    await reRegisterAction.click({ force: true });
    await page.waitForTimeout(300);

    await expect(
        page.getByText('Push notifications are not enabled for this device yet.', { exact: true }),
    ).toHaveCount(0);
});

test('桌面侧栏导航控件不覆盖底部账户入口', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(authenticatedWebUrl);

    await expect(page.getByRole('textbox')).toBeVisible();

    const zenButton = page.locator('[data-testid="desktop-navigation-controls"]');
    const accountFooter = page.locator('[data-testid="sidebar-account-footer"]');
    await expect(zenButton).toHaveCount(1);
    await expect(accountFooter).toHaveCount(1);
    const controls = await zenButton.boundingBox();
    const footer = await accountFooter.boundingBox();
    expect(controls).not.toBeNull();
    expect(footer).not.toBeNull();
    expect(controls!.x).toBeGreaterThanOrEqual(footer!.x + footer!.width);

    await page.screenshot({ path: 'test-results/desktop-sidebar-navigation.png', fullPage: true });
});

test('桌面三栏工作区支持独立折叠并保留禅模式前的偏好', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(authenticatedRoute('/new'));
    await expect(page.getByRole('textbox')).toBeVisible();

    const sidebarToggle = page.getByTestId('desktop-navigation-sidebar-button');
    const zenToggle = page.getByTestId('desktop-navigation-zen-button');
    const accountFooter = page.getByTestId('sidebar-account-footer');

    if (await zenToggle.getAttribute('aria-selected') === 'true') {
        await zenToggle.click();
    }
    if (await sidebarToggle.getAttribute('aria-expanded') === 'false') {
        await sidebarToggle.click();
    }
    if (!await page.locator('[data-testid="desktop-right-panel"]:visible').isVisible()) {
        await page.locator('[data-testid="desktop-right-panel-toggle-button"]:visible').click();
    }

    const rightPanel = page.locator('[data-testid="desktop-right-panel"]:visible');
    await expect(sidebarToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(rightPanel).toBeVisible();
    await expect(rightPanel.getByText('Capability Hub', { exact: true })).toHaveCount(2);
    await expect(rightPanel.getByText('Quick Prompts', { exact: true })).toBeVisible();
    await expect(page.getByTestId('sidebar-desktop-density')).toBeVisible();
    await pauseForRecordedReview(page);

    await sidebarToggle.hover();
    await expect(page.getByTestId('desktop-navigation-sidebar-tooltip')).toContainText('⌘B');
    await expect(sidebarToggle).toHaveAttribute('aria-keyshortcuts', 'Meta+B');
    await pauseForRecordedReview(page);

    const rightPanelToggle = page.locator('[data-testid="desktop-right-panel-toggle-button"]:visible');
    await rightPanelToggle.hover();
    await expect(page.getByTestId('desktop-right-panel-toggle-tooltip')).toContainText('⌥⌘B');
    await expect(rightPanelToggle).toHaveAttribute('aria-keyshortcuts', 'Alt+Meta+B');
    await expect(rightPanelToggle).toHaveAttribute('aria-expanded', 'true');
    await pauseForRecordedReview(page);

    await page.keyboard.press('Meta+KeyB');
    await expect(sidebarToggle).toHaveAttribute('aria-expanded', 'false');
    await pauseForRecordedReview(page);
    await page.keyboard.press('Meta+KeyB');
    await expect(sidebarToggle).toHaveAttribute('aria-expanded', 'true');
    await pauseForRecordedReview(page);

    await page.keyboard.press('Alt+Meta+KeyB');
    await expect(rightPanel).toHaveCount(0);
    await expect(rightPanelToggle).toHaveAttribute('aria-keyshortcuts', 'Alt+Meta+B');
    await expect(rightPanelToggle).toHaveAttribute('aria-expanded', 'false');
    await rightPanelToggle.hover();
    await expect(page.getByTestId('desktop-right-panel-toggle-tooltip')).toContainText('⌥⌘B');
    await pauseForRecordedReview(page);
    await page.keyboard.press('Alt+Meta+KeyB');
    await expect(rightPanel).toBeVisible();
    await pauseForRecordedReview(page);

    const leftPanel = page.getByTestId('desktop-left-sidebar');
    const mainPanel = page.locator('[data-testid="desktop-workspace-main"]:visible');
    const leftWidthBefore = (await leftPanel.boundingBox())!.width;
    const leftHandleBox = await page.getByTestId('desktop-left-panel-resize-handle').boundingBox();
    expect(leftHandleBox).not.toBeNull();
    await page.mouse.move(leftHandleBox!.x + leftHandleBox!.width / 2, leftHandleBox!.y + 100);
    await page.mouse.down();
    await page.mouse.move(leftHandleBox!.x + 85, leftHandleBox!.y + 100, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await leftPanel.boundingBox())?.width ?? 0).toBeGreaterThan(leftWidthBefore + 60);
    const resizedLeftWidth = (await leftPanel.boundingBox())!.width;
    const leftResizeHandle = page.getByTestId('desktop-left-panel-resize-handle');
    await expect(leftResizeHandle).toHaveAttribute('aria-valuenow', String(Math.round(resizedLeftWidth)));
    await leftResizeHandle.focus();
    await expect(leftResizeHandle).toHaveCSS('outline-style', 'none');
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await leftPanel.boundingBox())?.width ?? 0).toBeLessThan(resizedLeftWidth);
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => Math.abs(((await leftPanel.boundingBox())?.width ?? 0) - resizedLeftWidth)).toBeLessThanOrEqual(1);
    await sidebarToggle.hover();
    if (process.env.HAPPY_E2E_RECORD === '1') {
        await page.screenshot({
            path: 'test-results/pc-sidebar-left-after-1280x720.png',
            fullPage: true,
        });
    }
    await pauseForRecordedReview(page);

    await page.keyboard.press('Meta+KeyB');
    await expect(sidebarToggle).toHaveAttribute('aria-expanded', 'false');
    const rightWidthBefore = (await rightPanel.boundingBox())!.width;
    const rightHandleBox = await rightPanel.getByTestId('desktop-right-panel-resize-handle').boundingBox();
    expect(rightHandleBox).not.toBeNull();
    await page.mouse.move(rightHandleBox!.x + rightHandleBox!.width / 2, rightHandleBox!.y + 100);
    await page.mouse.down();
    await page.mouse.move(rightHandleBox!.x - 280, rightHandleBox!.y + 100, { steps: 10 });
    await page.mouse.up();
    await expect.poll(async () => (await rightPanel.boundingBox())?.width ?? 0).toBeGreaterThan(rightWidthBefore + 20);
    const resizedRightWidth = (await rightPanel.boundingBox())!.width;
    const rightResizeHandle = rightPanel.getByTestId('desktop-right-panel-resize-handle');
    await expect(rightResizeHandle).toHaveAttribute('aria-valuenow', String(Math.round(resizedRightWidth)));
    await rightResizeHandle.focus();
    await expect(rightResizeHandle).toHaveCSS('outline-style', 'none');
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await rightPanel.boundingBox())?.width ?? 0).toBeLessThan(resizedRightWidth);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => Math.abs(((await rightPanel.boundingBox())?.width ?? 0) - resizedRightWidth)).toBeLessThanOrEqual(1);
    await expect.poll(async () => (await mainPanel.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(479);
    await rightPanelToggle.hover();
    if (process.env.HAPPY_E2E_RECORD === '1') {
        await page.screenshot({
            path: 'test-results/pc-sidebar-right-after-1280x720.png',
            fullPage: true,
        });
    }
    await pauseForRecordedReview(page);
    await page.keyboard.press('Meta+KeyB');
    await expect(sidebarToggle).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(async () => (await mainPanel.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(479);

    const renderedLeftWidthAfterBoth = (await leftPanel.boundingBox())!.width;
    const renderedRightWidthAfterBoth = (await rightPanel.boundingBox())!.width;

    await page.screenshot({
        path: 'test-results/pc-workspace-panels-after-1280x720.png',
        fullPage: true,
    });

    const initialMainBox = await mainPanel.boundingBox();
    expect(initialMainBox).not.toBeNull();

    await rightPanelToggle.click();
    await expect(rightPanel).toHaveCount(0);
    await expect(rightPanelToggle).toHaveAttribute('aria-expanded', 'false');

    const rightCollapsedMainBox = await mainPanel.boundingBox();
    expect(rightCollapsedMainBox).not.toBeNull();
    expect(rightCollapsedMainBox!.width).toBeGreaterThan(initialMainBox!.width + 100);
    await pauseForRecordedReview(page);

    await rightPanelToggle.click();
    await expect(rightPanel).toBeVisible();
    await expect.poll(async () => (await mainPanel.boundingBox())?.width ?? 0).toBeLessThanOrEqual(initialMainBox!.width + 1);
    await pauseForRecordedReview(page);

    await sidebarToggle.click();
    await expect(sidebarToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(leftPanel).toHaveAttribute('data-happy-motion-state', 'closed');
    await expect(leftPanel).toHaveCSS('pointer-events', 'none');
    await expect(leftPanel).toHaveCSS('visibility', 'hidden');
    await expect(accountFooter).toBeHidden();

    const leftCollapsedMainBox = await mainPanel.boundingBox();
    expect(leftCollapsedMainBox).not.toBeNull();
    expect(leftCollapsedMainBox!.x).toBeLessThan(initialMainBox!.x - 20);
    expect(leftCollapsedMainBox!.width).toBeGreaterThan(initialMainBox!.width + 100);
    await pauseForRecordedReview(page);

    await zenToggle.click();
    await expect(zenToggle).toHaveAttribute('aria-selected', 'true');
    await expect(rightPanel).toHaveCount(0);
    await pauseForRecordedReview(page);

    await zenToggle.click();
    await expect(zenToggle).toHaveAttribute('aria-selected', 'false');
    await expect(rightPanel).toBeVisible();
    await expect(sidebarToggle).toHaveAttribute('aria-expanded', 'false');
    await pauseForRecordedReview(page);

    await sidebarToggle.click();
    await expect(sidebarToggle).toHaveAttribute('aria-expanded', 'true');

    await page.reload();
    await expect(sidebarToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(rightPanel).toBeVisible();
    await expect.poll(async () => Math.abs(((await leftPanel.boundingBox())?.width ?? 0) - renderedLeftWidthAfterBoth)).toBeLessThanOrEqual(1);
    await expect.poll(async () => Math.abs(((await rightPanel.boundingBox())?.width ?? 0) - renderedRightWidthAfterBoth)).toBeLessThanOrEqual(1);
    await expect.poll(async () => (await mainPanel.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(479);
    await page.keyboard.press('Meta+KeyB');
    await expect.poll(async () => Math.abs(((await rightPanel.boundingBox())?.width ?? 0) - resizedRightWidth)).toBeLessThanOrEqual(1);
    await page.keyboard.press('Meta+KeyB');
    await pauseForRecordedReview(page, 900);
});

test('超宽桌面左右侧栏保持各自最大宽度', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(authenticatedRoute('/new'));
    await expect(page.getByRole('textbox')).toBeVisible();

    const leftPanel = page.getByTestId('desktop-left-sidebar');
    const leftPanelSurface = page.getByTestId('sidebar-desktop-density');
    const mainPanel = page.locator('[data-testid="desktop-workspace-main"]:visible');
    const rightPanel = page.locator('[data-testid="desktop-right-panel"]:visible');
    const leftHandle = page.getByTestId('desktop-left-panel-resize-handle');
    const sidebarToggle = page.getByTestId('desktop-navigation-sidebar-button');

    const leftBefore = (await leftPanel.boundingBox())!.width;
    await dragHorizontalResizeHandle(page, leftHandle, 520);
    await expect.poll(async () => (await leftPanel.boundingBox())?.width ?? 0).toBeGreaterThan(leftBefore + 100);
    await expect.poll(async () => (await leftPanel.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(479);
    await expect.poll(async () => (await leftPanel.boundingBox())?.width ?? 0).toBeLessThanOrEqual(480);
    await expect(leftPanelSurface).toHaveCSS('border-right-width', '0px');
    await expect.poll(async () => (await mainPanel.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(479);

    await sidebarToggle.click();
    await expect(sidebarToggle).toHaveAttribute('aria-expanded', 'false');
    const rightBefore = (await rightPanel.boundingBox())!.width;
    await dragHorizontalResizeHandle(page, rightPanel.getByTestId('desktop-right-panel-resize-handle'), -520);
    await expect.poll(async () => (await rightPanel.boundingBox())?.width ?? 0).toBeGreaterThan(rightBefore + 100);
    await expect.poll(async () => (await rightPanel.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(479);
    await expect.poll(async () => (await rightPanel.boundingBox())?.width ?? 0).toBeLessThanOrEqual(480);
    await expect(rightPanel).toHaveCSS('border-left-width', '0px');
    await expect.poll(async () => (await mainPanel.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(479);

    await sidebarToggle.click();
    await expect(sidebarToggle).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(async () => (await leftPanel.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(479);
    await expect.poll(async () => (await rightPanel.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(479);
    await page.screenshot({
        path: 'test-results/pc-panel-bounds-after-1920x1080.png',
        fullPage: true,
    });
});

test('PC 端连续按两次 Esc 才发送停止指令', async ({ page, request }, testInfo) => {
    const fixture = await createConnectedE2EAbortSession(request);

    try {
        await page.setViewportSize({ width: 1280, height: 720 });
        await page.goto(authenticatedRoute(`/session/${fixture.sessionId}`));

        const input = page.getByTestId('session-message-input');
        await expect(input).toBeVisible();
        await expect(page.locator('[data-testid="message-composer-abort-button"]:visible')).toBeVisible();
        await page.screenshot({
            path: testInfo.outputPath('pc-double-escape-before.png'),
            fullPage: true,
        });

        await input.press('Escape');
        const armedAbortButton = page.locator('[data-testid="message-composer-abort-button"]:visible');
        await expect(armedAbortButton).toHaveText('Esc');
        expect(fixture.abortCalls).toHaveLength(0);
        await page.screenshot({
            path: testInfo.outputPath('pc-double-escape-after-first-escape.png'),
            fullPage: true,
        });

        await input.press('Escape');
        await expect.poll(() => fixture.abortCalls.length).toBe(1);
        const readyAbortButton = page.locator('[data-testid="message-composer-abort-button"]:visible');
        await expect(readyAbortButton).toBeVisible();
        await expect(readyAbortButton).toBeEnabled();

        // A running task can still be stopped with the shortcut while a
        // supplemental message has temporarily changed the primary action to send.
        await input.fill('Additional context while the task is running');
        await expect(page.locator('[data-testid="message-composer-send-button"]:visible')).toBeVisible();
        await input.press('Escape');
        await expect(page.locator('[data-testid="message-composer-abort-button"]:visible')).toHaveText('Esc');
        expect(fixture.abortCalls).toHaveLength(1);
        await input.press('Escape');
        await expect.poll(() => fixture.abortCalls.length).toBe(2);
    } finally {
        fixture.client.close();
    }
});

test('PC 暂停后可复制并原位编辑最后一条输入', async ({ context, page, request }, testInfo) => {
    const fixture = await createConnectedE2EAbortSession(request);
    const originalMessage = 'Please verify the paused task using the original instructions.';
    const editedMessage = 'Please verify the paused task and include the browser evidence.';

    try {
        fixture.setThinking(false);
        await createE2EUserMessage(request, fixture.sessionId, {
            text: originalMessage,
            model: 'gpt-5.6-sol',
            effort: 'xhigh',
            permission: 'default',
        });
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
            origin: new URL(authenticatedWebUrl).origin,
        });
        await page.setViewportSize({ width: 1280, height: 720 });
        await page.goto(authenticatedRoute(`/session/${fixture.sessionId}`));

        const originalText = page.getByText(originalMessage, { exact: true });
        await expect(originalText).toBeVisible();
        const originalContainer = page.locator('[data-testid^="message-user-"]').filter({ has: originalText }).first();
        const copyButton = originalContainer.getByRole('button', { name: 'Copy' });
        const editButton = originalContainer.getByRole('button', { name: 'Edit' });
        await expect(copyButton).toBeVisible();
        await expect(editButton).toBeVisible();
        await page.screenshot({
            path: testInfo.outputPath('pc-paused-message-actions-after.png'),
            fullPage: true,
        });
        await pauseForRecordedReview(page, 900);

        await copyButton.click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(originalMessage);
        const copiedButton = originalContainer.getByRole('button', { name: 'Copied' });
        const copiedFeedback = originalContainer.getByTestId(/^message-user-copy-feedback-/);
        await expect(copiedButton).toBeVisible();
        await expect(copiedFeedback).toHaveText('Copied');
        await page.screenshot({
            path: testInfo.outputPath('pc-paused-message-copy-feedback-after.png'),
            fullPage: true,
        });
        await pauseForRecordedReview(page, 1100);
        await expect(originalContainer.getByRole('button', { name: 'Copy' })).toBeVisible({ timeout: 3_000 });

        await editButton.click();
        const editor = page.getByRole('textbox', { name: 'Edit' });
        await expect(editor).toHaveValue(originalMessage);
        await pauseForRecordedReview(page, 900);
        await editor.fill('Temporary edit that should be cancelled.');
        await pauseForRecordedReview(page, 900);
        await page.getByRole('button', { name: 'Cancel' }).click();
        await expect(originalText).toBeVisible();
        await expect(editor).toHaveCount(0);
        await pauseForRecordedReview(page, 900);

        await originalContainer.getByRole('button', { name: 'Edit' }).click();
        const reopenedEditor = page.getByRole('textbox', { name: 'Edit' });
        await reopenedEditor.fill(editedMessage);
        await page.screenshot({
            path: testInfo.outputPath('pc-paused-message-editor-after.png'),
            fullPage: true,
        });
        await pauseForRecordedReview(page, 900);
        await page.getByRole('button', { name: 'Send' }).click();

        await expect(page.getByText(editedMessage, { exact: true })).toBeVisible();
        await expect(page.getByText(originalMessage, { exact: true })).toHaveCount(0);
        await pauseForRecordedReview(page, 1200);
        await page.reload();
        await expect(page.getByText(editedMessage, { exact: true })).toBeVisible();
        await expect(page.getByText(originalMessage, { exact: true })).toHaveCount(0);
        await pauseForRecordedReview(page, 900);
    } finally {
        fixture.client.close();
    }
});

test('活跃会话页面复用左右拖拽与折叠约束', async ({ page, request }) => {
    const sessionId = await createE2ESession(request);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(authenticatedRoute(`/session/${sessionId}`));

    const leftPanel = page.getByTestId('desktop-left-sidebar');
    const mainPanel = page.locator('[data-testid="desktop-workspace-main"]:visible');
    const rightPanel = page.locator('[data-testid="desktop-right-panel"]:visible');
    await expect(mainPanel).toBeVisible();
    await expect(rightPanel).toBeVisible();

    const leftBefore = (await leftPanel.boundingBox())!.width;
    await dragHorizontalResizeHandle(page, page.getByTestId('desktop-left-panel-resize-handle'), 70);
    await expect.poll(async () => (await leftPanel.boundingBox())?.width ?? 0).toBeGreaterThan(leftBefore + 40);

    const rightBefore = (await rightPanel.boundingBox())!.width;
    await dragHorizontalResizeHandle(page, rightPanel.getByTestId('desktop-right-panel-resize-handle'), -70);
    await expect.poll(async () => (await rightPanel.boundingBox())?.width ?? 0).toBeGreaterThan(rightBefore + 20);
    await expect.poll(async () => (await mainPanel.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(479);

    const sidebarToggle = page.getByTestId('desktop-navigation-sidebar-button');
    await sidebarToggle.click();
    await expect(sidebarToggle).toHaveAttribute('aria-expanded', 'false');
    const mainBeforeRightCollapse = (await mainPanel.boundingBox())!.width;
    const rightRestore = page.locator('[data-testid="desktop-right-panel-toggle-button"]:visible');
    await rightRestore.click();
    await expect(rightRestore).toBeVisible();
    await expect.poll(async () => (await mainPanel.boundingBox())?.width ?? 0).toBeGreaterThan(mainBeforeRightCollapse + 100);
    await sidebarToggle.click();
    await rightRestore.click();
    await expect(leftPanel).toBeVisible();
    await expect(rightPanel).toBeVisible();
});

test('PC 从右侧文件列表打开详情后标题与正文保持正确对齐', async ({ page, request }, testInfo) => {
    const fixture = await createConnectedE2EFileSession(request);

    try {
        await page.setViewportSize({ width: 1280, height: 720 });
        await page.goto(authenticatedRoute(`/session/${fixture.sessionId}`));

        const rightPanel = page.locator('[data-testid="desktop-right-panel"]:visible');
        await expect(rightPanel).toBeVisible();
        const filesBlock = rightPanel.getByTestId('capability-block-files');
        await expect(filesBlock).toContainText(fixture.fileName);
        await filesBlock.click();
        await rightPanel.getByText(fixture.fileName, { exact: true }).click();

        await expect.poll(() => new URL(page.url()).pathname).toBe(`/session/${fixture.sessionId}/file`);
        const title = page.getByText('File Viewer', { exact: true });
        const content = page.getByTestId('file-viewer-content');
        const navigationControls = page.getByTestId('desktop-navigation-controls');
        await expect(title).toBeVisible();
        await expect(content).toBeVisible();
        await expect(content).toContainText(fixture.fileContent);

        const titleBox = await title.boundingBox();
        const controlsBox = await navigationControls.boundingBox();
        expect(titleBox).not.toBeNull();
        expect(controlsBox).not.toBeNull();
        expect(
            titleBox!.x,
            '文件详情标题不得与桌面导航控件重叠',
        ).toBeGreaterThanOrEqual(controlsBox!.x + controlsBox!.width + 4);

        const sidebarBox = await page.getByTestId('desktop-left-sidebar').boundingBox();
        const contentBox = await content.boundingBox();
        expect(sidebarBox).not.toBeNull();
        expect(contentBox).not.toBeNull();
        expect(
            contentBox!.x - (sidebarBox!.x + sidebarBox!.width),
            '文件正文应贴近主内容区左侧，而不是被 maxWidth 容器居中推远',
        ).toBeLessThanOrEqual(24);

        await page.screenshot({
            path: testInfo.outputPath('pc-file-viewer-after-1280x720.png'),
            fullPage: true,
        });
    } finally {
        await fixture.client.close();
        rmSync(fixture.workspace, { force: true, recursive: true });
    }
});

test('[R10-03][TASK-CONTEXT] Capability Hub 仅投影成功资源并跨会话刷新隔离', async ({ page, request }, testInfo) => {
    const sessionId = await createE2ESession(request, { name: 'Task context active session' });
    const otherSessionId = await createE2ESession(request, { name: 'Task context isolated session' });
    const filePath = '/tmp/task-context-panel.md';
    const otherFilePath = '/tmp/other-session-secret.md';

    await createE2ECompletedToolCall(request, otherSessionId, {
        callId: 'other-write',
        input: { file_path: otherFilePath, content: 'isolated' },
        name: 'Write',
    });
    await createE2ECompletedToolCall(request, otherSessionId, {
        callId: 'other-fetch',
        input: { url: 'https://other.example/context' },
        name: 'WebFetch',
    });
    await createE2ECompletedToolCall(request, sessionId, {
        callId: 'failed-write',
        input: { file_path: '/tmp/task-context-failed.md', content: 'must stay excluded' },
        isError: true,
        name: 'Write',
        output: 'R10 write failed',
    });
    await createE2ECompletedToolCall(request, sessionId, {
        callId: 'failed-fetch',
        input: { url: 'https://failed.example.com/excluded' },
        isError: true,
        name: 'WebFetch',
        output: 'R10 fetch failed',
    });

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(authenticatedRoute(`/session/${sessionId}`));
    await expect(page.getByText('R10 write failed', { exact: true })).toBeVisible();
    await page.getByText('failed.example.com', { exact: true }).click();
    await expect(page.getByText('Error', { exact: true })).toBeVisible();
    await expect(page.getByText('R10 fetch failed', { exact: true })).toBeVisible();
    await page.goto(authenticatedRoute(`/session/${sessionId}`));
    if (!await page.locator('[data-testid="desktop-right-panel"]:visible').isVisible()) {
        await page.locator('[data-testid="desktop-right-panel-toggle-button"]:visible').click();
    }
    const rightPanel = page.locator('[data-testid="desktop-right-panel"]:visible');
    const outputsBlock = rightPanel.getByTestId('capability-block-outputs');
    const sourcesBlock = rightPanel.getByTestId('capability-block-sources');

    await expect(outputsBlock).toBeVisible();
    await expect(outputsBlock).toContainText('Files, previews, and other task results will appear here.');
    await expect(sourcesBlock).toContainText('Web links and attachments used in this task will appear here.');
    await expect(outputsBlock).not.toContainText('task-context-failed.md');
    await expect(sourcesBlock).not.toContainText('failed.example.com');
    await page.screenshot({
        path: testInfo.outputPath('task-context-empty-before-1280x720.png'),
        fullPage: true,
    });

    await createE2ECompletedToolCall(request, sessionId, {
        callId: 'task-context-write',
        input: { file_path: filePath, content: 'first version' },
        name: 'Write',
    });
    await createE2ECompletedToolCall(request, sessionId, {
        callId: 'task-context-fetch',
        input: { url: 'https://docs.example.com/happy/task-context' },
        name: 'WebFetch',
    });

    await expect(outputsBlock.getByText('1', { exact: true })).toBeVisible();
    await expect(outputsBlock).toContainText('task-context-panel.md');
    await expect(sourcesBlock.getByText('1', { exact: true })).toBeVisible();
    await expect(sourcesBlock).toContainText('docs.example.com');

    await outputsBlock.click();
    const outputRow = rightPanel.getByTestId('task-context-output-file');
    await expect(outputRow).toContainText(filePath);

    await createE2ECompletedToolCall(request, sessionId, {
        callId: 'task-context-edit',
        input: {
            file_path: filePath,
            old_string: 'first version',
            new_string: 'second version',
        },
        name: 'Edit',
    });
    await expect(rightPanel.getByTestId('task-context-output-file')).toHaveCount(1);
    await expect(outputRow).toContainText('Updated');
    await expect(outputRow).toContainText('×2');
    await page.screenshot({
        path: testInfo.outputPath('task-context-output-detail-after-1280x720.png'),
        fullPage: true,
    });

    await rightPanel.getByText('Back', { exact: true }).click();
    await expect(outputsBlock.getByText('1', { exact: true })).toBeVisible();
    await expect(sourcesBlock.getByText('1', { exact: true })).toBeVisible();
    await page.screenshot({
        path: testInfo.outputPath('task-context-summary-after-1280x720.png'),
        fullPage: true,
    });

    await outputsBlock.click();
    await rightPanel.getByTestId('task-context-output-file').click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/session/${sessionId}/file`);
    await page.goBack();

    await page.goto(authenticatedRoute(`/session/${otherSessionId}`));
    const otherRightPanel = page.locator('[data-testid="desktop-right-panel"]:visible');
    await otherRightPanel.getByTestId('capability-block-outputs').click();
    await expect(otherRightPanel.getByText('other-session-secret.md', { exact: true })).toBeVisible();
    await expect(otherRightPanel.getByText('task-context-panel.md', { exact: true })).toHaveCount(0);
    await otherRightPanel.getByText('Back', { exact: true }).click();
    await otherRightPanel.getByTestId('capability-block-sources').click();
    await expect(otherRightPanel.getByTestId('task-context-source-web')).toContainText('other.example');
    await expect(otherRightPanel.getByTestId('task-context-source-web')).not.toContainText('docs.example.com');

    await page.goto(authenticatedRoute(`/session/${sessionId}`));
    await page.reload();
    const reloadedRightPanel = page.locator('[data-testid="desktop-right-panel"]:visible');
    await reloadedRightPanel.getByTestId('capability-block-sources').click();
    const sourceRow = reloadedRightPanel.getByTestId('task-context-source-web');
    await expect(sourceRow).toContainText('docs.example.com');

    await page.context().route('https://docs.example.com/**', (route) => route.fulfill({
        contentType: 'text/html',
        body: '<title>Task context source</title>',
    }));
    const popupPromise = page.waitForEvent('popup');
    await sourceRow.click();
    const popup = await popupPromise;
    await expect.poll(() => popup.url()).toBe('https://docs.example.com/happy/task-context');
    await popup.close();
});

test('桌面问候语与输入框内容列对齐且代表性中文标题保持单行', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(new URL('/new', authenticatedWebUrl).toString());
    await expect(page.getByRole('textbox')).toBeVisible();

    const greeting = page.locator('[data-testid="compose-home-greeting"]:visible');
    const composerContent = page.locator('[data-testid="message-composer-content"]:visible');
    const greetingBox = await greeting.boundingBox();
    const composerContentBox = await composerContent.boundingBox();

    expect(greetingBox).not.toBeNull();
    expect(composerContentBox).not.toBeNull();
    expect(Math.abs(greetingBox!.x - composerContentBox!.x)).toBeLessThanOrEqual(1);

    const representativeGreetingFitsOneLine = await greeting.evaluate((element) => {
        const probe = element.cloneNode() as HTMLElement;
        probe.removeAttribute('data-testid');
        probe.textContent = '嗨 jacky，今天和 Paws 做点什么';
        probe.style.position = 'fixed';
        probe.style.visibility = 'hidden';
        probe.style.pointerEvents = 'none';
        element.parentElement!.appendChild(probe);

        const { height } = probe.getBoundingClientRect();
        const lineHeight = Number.parseFloat(window.getComputedStyle(probe).lineHeight);
        probe.remove();
        return height <= lineHeight + 1;
    });
    expect(representativeGreetingFitsOneLine).toBe(true);
});

test('桌面图片效果使用有边界的居中弹窗且支持 Escape 关闭', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const imageModeUrl = new URL(authenticatedRoute('/new'));
    imageModeUrl.searchParams.set('mode', 'image-styles');
    await page.goto(imageModeUrl.toString());

    const imagePanel = page.getByTestId('compose-home-image-agent-panel');
    await expect(imagePanel).toBeVisible();
    const imagePanelBox = await imagePanel.boundingBox();
    expect(imagePanelBox).not.toBeNull();
    expect(imagePanelBox!.width).toBeLessThanOrEqual(800);

    await page.getByTestId('compose-home-image-effect-action').click();
    const dialog = page.getByTestId('image-style-gallery-dialog');
    await expect(dialog).toBeVisible();

    const dialogBox = await dialog.boundingBox();
    expect(dialogBox).not.toBeNull();
    expect(dialogBox!.width).toBeLessThanOrEqual(1040);
    expect(dialogBox!.height).toBeLessThanOrEqual(760);
    expect(dialogBox!.x).toBeGreaterThanOrEqual(32);
    expect(dialogBox!.y).toBeGreaterThanOrEqual(32);

    const categoriesFit = await page.getByTestId('image-style-gallery-categories').evaluate((element) => ({
        horizontal: element.scrollWidth <= element.clientWidth,
        vertical: element.scrollHeight <= element.clientHeight,
    }));
    expect(categoriesFit).toEqual({ horizontal: true, vertical: true });

    await page.getByRole('button', { name: /GitHub Skills/ }).click();
    const githubSkillCovers = dialog.locator('img');
    await expect(githubSkillCovers).toHaveCount(6);
    await expect.poll(async () => githubSkillCovers.evaluateAll((images) => images.every((image) => {
        const element = image as HTMLImageElement;
        return element.complete && element.naturalWidth > 0 && element.naturalHeight > 0;
    }))).toBe(true);
    const coverLayout = await githubSkillCovers.evaluateAll((images) => images.map((image) => {
        const element = image as HTMLImageElement;
        const imageBox = element.getBoundingClientRect();
        const parentBox = element.parentElement!.getBoundingClientRect();
        return {
            naturalRatio: element.naturalWidth / element.naturalHeight,
            displayedRatio: imageBox.width / imageBox.height,
            fillsParent: Math.abs(imageBox.width - parentBox.width) <= 1
                && Math.abs(imageBox.height - parentBox.height) <= 1,
        };
    }));
    for (const cover of coverLayout) {
        expect(cover.naturalRatio).toBeCloseTo(4 / 3, 2);
        expect(cover.displayedRatio).toBeCloseTo(cover.naturalRatio, 1);
        expect(cover.fillsParent).toBe(true);
    }
    if (process.env.HAPPY_E2E_EVIDENCE_PATH) {
        await page.screenshot({ path: process.env.HAPPY_E2E_EVIDENCE_PATH });
    }
    if (process.env.HAPPY_E2E_EVIDENCE_BOTTOM_PATH) {
        await githubSkillCovers.last().evaluate((image) => {
            let element: HTMLElement | null = image.parentElement;
            while (element) {
                if (element.scrollHeight > element.clientHeight) {
                    element.scrollTop = element.scrollHeight;
                }
                element = element.parentElement;
            }
        });
        await page.screenshot({ path: process.env.HAPPY_E2E_EVIDENCE_BOTTOM_PATH });
    }

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
});

test('手机首页抽屉、Agent 卡片与账户菜单保持全宽对齐', async ({ page, request }, testInfo) => {
    const sessionId = await createE2ESession(request, {
        path: '/workspace/mobile-layout',
        host: 'mobile-e2e',
        machineId: 'mobile-e2e-machine',
        name: 'Mobile sidebar layout review',
    });
    await createE2ESession(request, {
        path: '/workspace/mobile-layout',
        host: 'mobile-e2e',
        machineId: 'mobile-e2e-machine',
        name: 'Mobile account menu spacing',
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(authenticatedWebUrl);
    await expect(page.getByRole('textbox')).toBeVisible();

    const phoneDrawerButton = page.getByTestId('compose-home-drawer-button');
    const accountFooter = page.getByTestId('sidebar-account-footer');
    await expect(phoneDrawerButton).toBeVisible();
    const closedSidebarBox = await accountFooter.boundingBox();
    expect(closedSidebarBox).not.toBeNull();
    expect(closedSidebarBox!.x + closedSidebarBox!.width).toBeLessThanOrEqual(0);

    await phoneDrawerButton.click();
    await expect.poll(async () => (await accountFooter.boundingBox())?.x ?? -1).toBeGreaterThanOrEqual(0);

    const newSession = page.getByTestId('sidebar-new-session-button');
    const myAgents = page.getByTestId('sidebar-my-agents-button');
    const accountTrigger = page.getByTestId('sidebar-account-trigger');
    const firstSession = page.getByTestId(`session-row-${sessionId}`);
    await expect(newSession).toBeVisible();
    await expect(myAgents).toBeVisible();
    await expect(accountTrigger).toBeVisible();
    await expect(firstSession).toBeVisible();

    const newSessionBox = await newSession.boundingBox();
    const myAgentsBox = await myAgents.boundingBox();
    const accountTriggerBox = await accountTrigger.boundingBox();
    const firstSessionBox = await firstSession.boundingBox();
    expect(newSessionBox).not.toBeNull();
    expect(myAgentsBox).not.toBeNull();
    expect(accountTriggerBox).not.toBeNull();
    expect(firstSessionBox).not.toBeNull();
    expect(Math.abs(myAgentsBox!.x - newSessionBox!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(myAgentsBox!.width - newSessionBox!.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(accountTriggerBox!.x - newSessionBox!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(accountTriggerBox!.width - newSessionBox!.width)).toBeLessThanOrEqual(1);
    expect(firstSessionBox!.y).toBeGreaterThanOrEqual(myAgentsBox!.y + myAgentsBox!.height);
    await pauseForRecordedReview(page, 900);

    await page.screenshot({
        path: testInfo.outputPath('mobile-sidebar-open-390x844.png'),
        fullPage: true,
    });

    await accountTrigger.click();
    const accountMenu = page.getByTestId('sidebar-account-menu');
    await expect(accountMenu).toBeVisible();
    await expect(newSession).toBeInViewport();
    await expect(accountTrigger).toBeInViewport();
    const accountMenuBox = await accountMenu.boundingBox();
    const expandedTriggerBox = await accountTrigger.boundingBox();
    const expandedNewSessionBox = await newSession.boundingBox();
    expect(accountMenuBox).not.toBeNull();
    expect(expandedTriggerBox).not.toBeNull();
    expect(expandedNewSessionBox).not.toBeNull();
    expect(Math.abs(accountMenuBox!.x - expandedTriggerBox!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(accountMenuBox!.width - expandedTriggerBox!.width)).toBeLessThanOrEqual(1);
    expect(accountMenuBox!.y).toBeGreaterThanOrEqual(0);
    expect(accountMenuBox!.y + accountMenuBox!.height).toBeLessThanOrEqual(expandedTriggerBox!.y);
    expect(expandedNewSessionBox!.y).toBeGreaterThanOrEqual(0);
    expect(expandedTriggerBox!.y + expandedTriggerBox!.height).toBeLessThanOrEqual(844);
    await pauseForRecordedReview(page, 1100);

    await page.screenshot({
        path: testInfo.outputPath('mobile-account-menu-open-390x844.png'),
        fullPage: true,
    });
});

test('侧栏底部账户菜单统一提供身份与系统操作并恢复焦点', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(authenticatedWebUrl);
    await expect(page.getByRole('textbox')).toBeVisible();

    const footer = page.getByTestId('sidebar-account-footer');
    const trigger = page.getByTestId('sidebar-account-trigger');
    await expect(footer).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    const footerBox = await footer.boundingBox();
    const viewport = page.viewportSize();
    expect(footerBox).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(viewport!.height);
    expect(footerBox!.y).toBeGreaterThan(viewport!.height / 2);

    await trigger.click();
    const menu = page.getByTestId('sidebar-account-menu');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(menu).toBeVisible();
    await expect(page.getByTestId('sidebar-account-profile-action')).toBeFocused();
    await expect(page.getByTestId('sidebar-account-settings-action')).toBeVisible();
    await expect(page.getByTestId('sidebar-account-details-action')).toBeVisible();
    await expect(page.getByTestId('sidebar-account-help-action')).toBeVisible();
    await expect(page.getByTestId('sidebar-account-logout-action')).toBeVisible();
    await page.screenshot({
        path: testInfo.outputPath('desktop-account-menu-after-1280x900.png'),
        fullPage: true,
    });

    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await page.setViewportSize({ width: 799, height: 900 });
    await page.goto(authenticatedWebUrl);
    await page.getByTestId('compose-home-drawer-button').click();
    await expect(page.getByTestId('sidebar-account-trigger')).toBeVisible();
    await page.getByTestId('sidebar-account-trigger').click();
    await expect(page.getByTestId('sidebar-account-menu')).toBeVisible();
});

test('[R10-06] Logout 取消在桌面和手机保持认证并恢复账户入口交互', async ({ page }) => {
    const scenarios = [
        { name: 'desktop', viewport: { width: 1280, height: 900 }, opensDrawer: false },
        { name: 'phone', viewport: { width: 390, height: 844 }, opensDrawer: true },
    ] as const;

    for (const scenario of scenarios) {
        await test.step(scenario.name, async () => {
            await page.setViewportSize(scenario.viewport);
            await page.goto(authenticatedWebUrl);
            await expect(page.getByRole('textbox')).toBeVisible();

            if (scenario.opensDrawer) {
                await page.getByTestId('compose-home-drawer-button').click();
            }

            const trigger = page.getByTestId('sidebar-account-trigger');
            const menu = page.getByTestId('sidebar-account-menu');
            await expect(trigger).toBeVisible();
            await trigger.click();
            await expect(menu).toBeVisible();

            await page.getByTestId('sidebar-account-logout-action').click();
            const dialog = page.getByRole('dialog', { name: 'Logout', exact: true });
            await expect(dialog).toBeVisible();
            await expect(menu).toHaveCount(0);
            await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

            await expect(dialog).toHaveCount(0);
            await expect(menu).toHaveCount(0);
            await expect(trigger).toHaveAttribute('aria-expanded', 'false');

            await trigger.click();
            await expect(menu).toBeVisible();
            await expect(page.getByTestId('sidebar-account-profile-action')).toBeFocused();
            await page.keyboard.press('Escape');
            await expect(menu).toHaveCount(0);
            await expect(trigger).toBeFocused();

            if (scenario.opensDrawer) {
                await page.getByTestId('compose-home-drawer-button').click();
                await expect(trigger).toBeVisible();
            }

            await trigger.click();
            await expect(menu).toBeVisible();
            await page.getByTestId('sidebar-account-details-action').click();
            await expect.poll(() => new URL(page.url()).pathname).toBe('/settings/account');
            await expect(page.getByText('Logout', { exact: true })).toBeVisible();
        });
    }
});

test('生产截图脱敏锚点随底部账户入口更新', async ({ page }) => {
    await installProductionRedaction(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(authenticatedWebUrl);
    await expect(page.getByRole('textbox')).toBeVisible();
    await expectProductionRedactionReady(page);
});

for (const width of [800, 1280]) {
    test(`宽度 ${width}px 的桌面首页不显示手机抽屉菜单`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(authenticatedWebUrl);
        await expect(page.getByRole('textbox')).toBeVisible();

        await expect(page.getByTestId('compose-home-drawer-button')).toHaveCount(0);
    });
}

for (const width of [800, 1280]) {
    test(`宽度 ${width}px 的 /new 使用全局返回，且头部控件命中区域不重叠`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(authenticatedWebUrl);
        await expect(page.getByRole('textbox')).toBeVisible();
        await page.getByTestId('sidebar-new-session-button').click();
        await expect(page).toHaveURL(new URL('/new', authenticatedWebUrl).toString());

        await expect(page.getByTestId('compose-home-back-button')).toHaveCount(0);
        const navigationControls = page.getByTestId('desktop-navigation-controls');
        const backButton = page.getByTestId('desktop-navigation-back-button');
        const controlsBox = await navigationControls.boundingBox();
        expect(controlsBox).not.toBeNull();
        await expect(page.locator('[data-testid="compose-home-model-chip"]:visible')).toHaveCount(1);
        await expect(page.locator('[data-testid="new-session-composer-controls"]:visible')).toBeVisible();
        await expect(backButton).toBeEnabled();
        await backButton.click();

        await expect(page).toHaveURL(authenticatedWebUrl);
        await expect(page.getByRole('textbox')).toBeVisible();
    });
}

test('窄屏新建会话保留头部配置下拉且不重复渲染底栏入口', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(authenticatedRoute('/new'));
    await expect(page.getByRole('textbox')).toBeVisible();

    const modelChip = page.locator('[data-testid="compose-home-model-chip"]:visible');
    await expect(modelChip).toBeVisible();
    await expect(page.getByTestId('new-session-composer-controls')).toHaveCount(0);
    await modelChip.click();
    await expect(page.getByTestId('compose-home-config-panel')).toBeVisible();
});

for (const width of [1024, 1280, 1440]) {
    test(`宽度 ${width}px 的模型选择器使用有边界的 PC 弹窗`, async ({ page }) => {
        await page.setViewportSize({ width, height: 720 });
        await page.goto(authenticatedRoute('/new'));
        await expect(page.getByRole('textbox')).toBeVisible();

        await page.locator('[data-testid="new-session-composer-controls"]:visible [data-testid="compose-home-model-chip"]:visible').click();
        const configPanel = page.getByTestId('compose-home-config-panel');
        await expect(configPanel).toBeVisible();
        const configBox = await configPanel.boundingBox();
        expect(configBox).not.toBeNull();
        expect(configBox!.width).toBeLessThanOrEqual(800);

        await page.getByTestId('session-config-model-trigger').click();
        const dialog = page.getByTestId('session-config-picker-model');
        await expect(dialog).toBeVisible();

        const dialogBox = await dialog.boundingBox();
        expect(dialogBox).not.toBeNull();
        expect(dialogBox!.width).toBeLessThanOrEqual(520);
        expect(dialogBox!.x).toBeGreaterThanOrEqual(32);
        expect(dialogBox!.y).toBeGreaterThanOrEqual(32);
        expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(width - 32);
        expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(720 - 32);

        const searchInput = dialog.getByRole('textbox');
        await expect(searchInput).toBeFocused();
        const fontSize = await searchInput.evaluate((element) => Number.parseFloat(
            window.getComputedStyle(element).fontSize,
        ));
        expect(fontSize).toBeLessThanOrEqual(14);

        const options = dialog.getByRole('radio');
        expect(await options.count()).toBeGreaterThan(1);
        await expect(dialog.getByRole('radio', { checked: true })).toHaveCount(1);

        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
    });
}

test('桌面 Machine Picker 各关闭入口重复退出后都把焦点返回触发器', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(authenticatedRoute('/new'));
    await expect(page.getByRole('textbox')).toBeVisible();

    const machineTrigger = page.getByTestId('session-config-machine-trigger');
    if (!await machineTrigger.isVisible()) {
        await page.locator('[data-testid="new-session-composer-controls"]:visible [data-testid="compose-home-model-chip"]:visible').click();
    }
    await expect(machineTrigger).toBeVisible();

    const dialog = page.getByTestId('session-config-picker-machine');
    for (const closeMethod of ['escape', 'close-button', 'scrim'] as const) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            await machineTrigger.click();
            await expect(dialog.getByRole('textbox')).toBeFocused();

            if (closeMethod === 'escape') {
                await page.keyboard.press('Escape');
            } else if (closeMethod === 'close-button') {
                await dialog.getByRole('button', { name: /^(Close|关闭)$/ }).click();
            } else {
                await page.getByTestId('session-config-picker-scrim').click({
                    position: { x: 8, y: 8 },
                });
            }

            await expect(dialog).toHaveCount(0);
            await expect(machineTrigger).toBeFocused();
        }
    }
});

test('桌面 Machine 与 Agent Picker 支持标准键盘激活并在关闭后回焦', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(authenticatedRoute('/new'));
    await expect(page.getByRole('textbox')).toBeVisible();

    const machineTrigger = page.getByTestId('session-config-machine-trigger');
    if (!await machineTrigger.isVisible()) {
        await page.locator('[data-testid="new-session-composer-controls"]:visible [data-testid="compose-home-model-chip"]:visible').click();
    }

    for (const picker of [
        {
            trigger: machineTrigger,
            dialog: page.getByTestId('session-config-picker-machine'),
        },
        {
            trigger: page.getByTestId('session-config-agent-trigger'),
            dialog: page.getByTestId('session-config-picker-agent'),
        },
    ]) {
        await expect(picker.trigger).toHaveAttribute('role', 'button');
        await expect(picker.trigger).toHaveAccessibleName(/.+/);
        await expect(picker.trigger).toHaveAttribute('aria-expanded', 'false');

        for (const activationKey of ['Space', 'Enter'] as const) {
            await picker.trigger.focus();
            await page.screenshot({
                path: testInfo.outputPath(`${await picker.trigger.getAttribute('data-testid')}-${activationKey}-before.png`),
                fullPage: true,
            });
            await picker.trigger.press(activationKey);
            await expect(picker.dialog).toBeVisible();
            await expect(picker.trigger).toHaveAttribute('aria-expanded', 'true');
            await page.screenshot({
                path: testInfo.outputPath(`${await picker.trigger.getAttribute('data-testid')}-${activationKey}-open.png`),
                fullPage: true,
            });

            await page.keyboard.press('Escape');
            await expect(picker.dialog).toHaveCount(0);
            await expect(picker.trigger).toBeFocused();
            await expect(picker.trigger).toHaveAttribute('aria-expanded', 'false');
            await page.screenshot({
                path: testInfo.outputPath(`${await picker.trigger.getAttribute('data-testid')}-${activationKey}-after.png`),
                fullPage: true,
            });
        }
    }
});

for (const width of [1024, 1280, 1440]) {
    test(`宽度 ${width}px 的禅模式导航与会话目标不重叠`, async ({ page }) => {
        await page.setViewportSize({ width, height: 720 });
        await page.goto(authenticatedRoute('/new'));
        await expect(page.getByRole('textbox')).toBeVisible();

        const zenButton = page.getByTestId('desktop-navigation-zen-button');
        const selected = await zenButton.getAttribute('aria-selected');
        if (selected === 'true') {
            await zenButton.click();
        }
        await zenButton.click();

        const controlsBox = await page.getByTestId('desktop-navigation-controls').boundingBox();
        expect(controlsBox).not.toBeNull();
        expect(controlsBox!.x).toBeLessThanOrEqual(32);
        await expect(page.locator('[data-testid="new-session-composer-controls"]:visible')).toBeVisible();

        await zenButton.click();
    });
}

test.describe('中文 Web 语音设置', () => {
    test.use({ locale: 'zh-CN' });

    test('开发者诊断完成本地化、保持紧凑且页面加载没有失败 Fetch', async ({ page }) => {
        await page.goto(authenticatedWebUrl);
        await expect(page.getByRole('textbox')).toBeVisible();

        const voicePage = await page.context().newPage();
        const failedFetchStatuses: number[] = [];
        const failedUsageFetchRequests: string[] = [];
        voicePage.on('response', (response) => {
            if (response.request().resourceType() === 'fetch' && response.status() >= 400) {
                failedFetchStatuses.push(response.status());
            }
        });
        voicePage.on('requestfailed', (request) => {
            if (request.resourceType() === 'fetch' && request.method() === 'GET') {
                failedUsageFetchRequests.push(request.failure()?.errorText ?? 'unknown');
            }
        });

        await voicePage.setViewportSize({ width: 1280, height: 900 });
        await voicePage.goto(new URL('/settings/voice', authenticatedWebUrl).toString());

        await expect(voicePage.getByText('开发者', { exact: true })).toBeVisible();
        const statusTitle = voicePage.getByText('语音实验状态', { exact: true });
        await expect(statusTitle).toBeVisible();
        await expect(voicePage.getByText('重置语音计数', { exact: true })).toBeVisible();
        await expect(voicePage.getByText(/Voice 升级推荐：对照组/)).toBeVisible();
        await expect(voicePage.getByText(/来源：默认值/)).toBeVisible();
        await expect(voicePage.getByText(/访问方式：Paws 服务器访问控制/)).toBeVisible();
        await expect(voicePage.getByText(/实验功能设置：(开启|关闭)/)).toBeVisible();
        await expect(voicePage.getByText(/软付费墙展示次数：0/)).toBeVisible();
        await expect(voicePage.getByText(/新手引导提示词加载次数：0/)).toBeVisible();
        await expect(voicePage.getByText(/Voice 消息数：0/)).toBeVisible();

        await expect(voicePage.getByTestId('voice-usage-loading')).toHaveCount(0);
        const statusRowBox = await voicePage.getByTestId('voice-experiment-status-row').boundingBox();
        const resetRowBox = await voicePage.getByTestId('voice-reset-counters-row').boundingBox();
        const developerFooterBox = await voicePage.getByText(
            '当前 Voice 灰度发布的开发者诊断与本地控制。除非同时启用“直接连接”和自定义 ElevenLabs 代理，否则付费 Voice 的访问控制由 Paws 服务器处理。',
            { exact: true },
        ).boundingBox();
        expect(statusRowBox).not.toBeNull();
        expect(resetRowBox).not.toBeNull();
        expect(developerFooterBox).not.toBeNull();
        expect(statusRowBox!.height).toBeLessThanOrEqual(resetRowBox!.height + 1);
        expect(statusRowBox!.y + statusRowBox!.height).toBeLessThanOrEqual(resetRowBox!.y);
        expect(resetRowBox!.y + resetRowBox!.height).toBeLessThanOrEqual(developerFooterBox!.y);
        expect(failedFetchStatuses).toEqual([]);
        expect(failedUsageFetchRequests).toEqual([]);
        await voicePage.screenshot({
            path: 'test-results/voice-settings-desktop-zh.png',
            fullPage: true,
        });
    });
});

test.describe('中文 Web 语言设置', () => {
    test.use({ locale: 'zh-CN' });

    test('切换语言前使用待确认语义并允许取消', async ({ page }) => {
        await page.goto(new URL('/settings/language', authenticatedWebUrl).toString());
        await page.getByText('English', { exact: true }).click();

        await expect(page.getByText('需要重启应用', { exact: true })).toBeVisible();
        await page.getByText('取消', { exact: true }).click();
        await expect(page.getByText('需要重启应用', { exact: true })).toHaveCount(0);
    });
});

test.describe('中文 Web 资料与使用情况设置', () => {
    test.use({ locale: 'zh-CN' });

    test('使用情况提供可见标题、周期按钮语义和空数据反馈', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto(authenticatedRoute('/settings/usage'));

        const visibleTitle = page.getByText('使用情况', { exact: true }).filter({ visible: true });
        await expect(visibleTitle).toBeVisible();
        const titleBox = await visibleTitle.boundingBox();
        expect(titleBox).not.toBeNull();
        expect(titleBox!.width).toBeGreaterThan(0);
        expect(titleBox!.height).toBeGreaterThan(0);

        await expect(page.getByText('暂无使用数据', { exact: true })).toBeVisible();
        await expect(page.getByRole('tablist', { name: '使用情况' })).toBeVisible();
        const todayButton = page.getByRole('tab', { name: '今天' });
        const weekButton = page.getByRole('tab', { name: '过去 7 天' });
        const monthButton = page.getByRole('tab', { name: '过去 30 天' });
        await expect(todayButton).toBeVisible();
        await expect(weekButton).toBeVisible();
        await expect(monthButton).toBeVisible();
        await expect(weekButton).toHaveAttribute('aria-selected', 'true');

        await todayButton.click();
        await expect(todayButton).toHaveAttribute('aria-selected', 'true');
        await expect(weekButton).toHaveAttribute('aria-selected', 'false');
    });

    test('资料保存操作暴露按钮语义并在可逆编辑后恢复禁用', async ({ page }) => {
        await page.goto(authenticatedRoute('/settings/profile'));

        const saveButton = page.getByRole('button', { name: '保存' });
        const nameInput = page.getByRole('textbox', { name: '姓名' });
        await expect(saveButton).toBeDisabled();

        const originalName = await nameInput.inputValue();
        await nameInput.fill(`${originalName}x`);
        await expect(saveButton).toBeEnabled();

        await nameInput.fill(originalName);
        await expect(saveButton).toBeDisabled();
    });
});

test.describe('中文 Web 自定义指令与 Skills 设置', () => {
    test.use({ locale: 'zh-CN' });

    test('自定义指令输入框使用可见标签且适配 800px 桌面断点', async ({ page }) => {
        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/settings/custom-instructions'));

        const instructions = page.getByRole('textbox', { name: '指令内容' });
        await expect(instructions).toBeVisible();
        const inputBox = await instructions.boundingBox();
        expect(inputBox).not.toBeNull();
        expect(inputBox!.width).toBeGreaterThan(450);

        await instructions.focus();
        await expect(instructions).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(instructions).not.toBeFocused();
    });

    test('Skills 空态或搜索交互不会产生 key 或文本节点错误', async ({ page }) => {
        const renderErrors: string[] = [];
        page.on('console', (message) => {
            if (
                message.type() === 'error'
                && (
                    message.text().includes('Encountered two children with the same key')
                    || message.text().includes('Unexpected text node')
                )
            ) {
                renderErrors.push(message.text());
            }
        });

        await page.goto(authenticatedRoute('/settings/skills'));
        const search = page.getByRole('textbox', { name: '搜索名称或触发词…' });
        const noMachine = page.getByText('无在线机器，请先连接一台机器', { exact: true });
        await expect(search.or(noMachine)).toBeVisible();

        if (await search.isVisible()) {
            await search.fill('zzzz-audit-no-match');
            await expect(search).toHaveValue('zzzz-audit-no-match');
            // 隔离环境里的机器可能仍在扫描本机 Skills。搜索交互不应把
            // 合法的加载态误判为“无匹配”，两种可观察状态都属于稳定 UI。
            const noMatches = page.getByText('无匹配的 Skills', { exact: true });
            const loading = page.getByRole('progressbar');
            await expect(noMatches.or(loading)).toBeVisible();
            await search.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
            await search.press('Backspace');
            await expect(search).toHaveValue('');
        } else {
            await expect(noMachine).toBeVisible();
        }

        expect(renderErrors).toEqual([]);
    });
});

test.describe('中文 Web 功能与账户设置语义', () => {
    test.use({ locale: 'zh-CN' });

    test('所有功能开关使用可见标题作为名称并支持可逆切换', async ({ page }) => {
        await page.goto(authenticatedRoute('/settings/features'));

        const switchNames = [
            '文件差异侧边栏',
            '分组工具调用',
            '实验功能',
            'Markdown 复制 v2',
            '隐藏非活跃会话',
            '恢复会话',
            '桌面截图',
            '禁用分析',
            '回车发送',
            '命令面板',
        ];
        await expect(page.getByRole('switch')).toHaveCount(switchNames.length);
        for (const name of switchNames) {
            await expect(page.getByRole('switch', { name, exact: true })).toHaveCount(1);
        }

        const analyticsSwitch = page.getByRole('switch', { name: '禁用分析', exact: true });
        const wasChecked = await analyticsSwitch.isChecked();
        await analyticsSwitch.click();
        try {
            await expect(analyticsSwitch).toBeChecked({ checked: !wasChecked });
        } finally {
            if (await analyticsSwitch.isChecked() !== wasChecked) {
                await analyticsSwitch.click();
            }
        }
        await expect(analyticsSwitch).toBeChecked({ checked: wasChecked });
    });

    test('账户分析开关和破坏性确认框使用稳定按钮语义', async ({ page }) => {
        await page.goto(authenticatedRoute('/settings/account'));

        await expect(page.getByRole('switch', { name: '分析', exact: true })).toBeVisible();
        await page.getByText('登出', { exact: true }).click();

        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeVisible();
        await expect(dialog.getByRole('button', { name: '登出', exact: true })).toBeVisible();
        await dialog.getByRole('button', { name: '取消', exact: true }).click();
        await expect(dialog).toHaveCount(0);
    });
});

test.describe('中文 Web 服务配置设置语义', () => {
    test.use({ locale: 'zh-CN' });

    test('Ask API 输入框使用可见标题且不修改配置', async ({ page }) => {
        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/settings/ask'));

        const apiKey = page.locator('input[aria-label="API Key"]');
        const apiUrl = page.locator('input[aria-label="API URL"]');
        const searchKey = page.locator('input[aria-label="Tavily API Key"]');

        await expect(apiKey).toHaveAttribute('type', 'password');
        await expect(apiUrl).toHaveAttribute('type', 'url');
        await expect(searchKey).toHaveAttribute('type', 'password');
        await expect(page.getByRole('button', { name: '清除 Ask API' })).toBeDisabled();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);
    });

    test('公开图片网关区分外部入口与只读状态', async ({ page }) => {
        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/settings/public-image-gateway'));

        await expect(page.getByRole('button', { name: '打开公开页面' })).toHaveCount(1);
        await expect(page.getByRole('button', { name: '打开审核后台' })).toHaveCount(1);
        await expect(page.getByRole('button', { name: 'Mac mini worker' })).toHaveCount(0);
        await expect(page.getByText('Mac mini worker', { exact: true })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);
    });
});

test.describe('中文 Web Agent 配置语义', () => {
    test.use({ locale: 'zh-CN' });

    test('智能体默认设置暴露展开状态与单选语义', async ({ page }) => {
        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/settings/agents'));

        const permissionField = page.getByRole('button', { name: /权限/ }).first();
        await expect(permissionField).toHaveAttribute('aria-expanded', 'false');

        await permissionField.click();
        await expect(permissionField).toHaveAttribute('aria-expanded', 'true');

        const permissionGroup = page.getByRole('radiogroup', { name: '权限' }).first();
        await expect(permissionGroup).toBeVisible();
        await expect(permissionGroup.getByRole('radio', { name: /使用代码默认值/ })).toBeChecked();

        await permissionField.click();
        await expect(permissionField).toHaveAttribute('aria-expanded', 'false');
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);
    });

    test('新建 Agent 表单具备输入与选择语义且不保存配置', async ({ page }) => {
        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/settings/my-agent-edit'));

        await expect(page.getByRole('textbox', { name: '名称' })).toHaveCount(1);
        await expect(page.getByRole('textbox', { name: '文件夹' })).toHaveAttribute('placeholder', '文件夹路径，如 ~');
        await expect(page.getByText('using custom path above', { exact: true })).toHaveCount(0);
        await expect(page.getByText('Recent', { exact: true })).toHaveCount(0);
        await expect(page.getByText('no recent projects yet', { exact: true })).toHaveCount(0);

        const kindGroup = page.getByRole('radiogroup', { name: 'Agent 类型' });
        await expect(kindGroup.getByRole('radio', { name: /标准 Agent/ })).toBeChecked();
        await expect(kindGroup.getByRole('radio', { name: /GPT Image 2 风格/ })).not.toBeChecked();

        await kindGroup.getByRole('radio', { name: /GPT Image 2 风格/ }).click();
        await expect(kindGroup.getByRole('radio', { name: /GPT Image 2 风格/ })).toBeChecked();
        await expect(page.getByRole('checkbox', { name: '山野旅行速写手帐' })).toBeChecked();

        const variants = page.getByRole('radiogroup', { name: '生成张数' });
        await expect(variants.getByRole('radio', { name: '每种风格 1 张' })).toBeChecked();

        await kindGroup.getByRole('radio', { name: /标准 Agent/ }).click();
        const flavorGroup = page.getByRole('radiogroup', { name: '编码 Agent' });
        await expect(flavorGroup.getByRole('radio', { name: '跟随默认' })).toBeChecked();

        await page.getByRole('button', { name: '添加预设' }).click();
        await expect(page.getByRole('textbox', { name: '标签' })).toHaveCount(1);
        await expect(page.getByRole('textbox', { name: '指令内容' })).toHaveCount(1);
        await page.getByRole('button', { name: '删除' }).click();

        await expect(page.getByRole('button', { name: '保存' })).toBeDisabled();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);
    });
});

test.describe('中文 Web 工件与生成图片语义', () => {
    test.use({ locale: 'zh-CN' });

    test('工件空态、新建表单和校验提示均具备稳定语义', async ({ page }) => {
        const debugLogs: string[] = [];
        page.on('console', (message) => {
            if (message.text().includes('ArtifactsScreen:')) {
                debugLogs.push(message.text());
            }
        });

        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/artifacts'));

        await expect(page.getByText('暂无工件', { exact: true })).toBeVisible();
        const createButton = page.getByRole('button', { name: '新建工件', exact: true });
        await expect(createButton).toHaveCount(1);
        await expect(createButton).toBeVisible();
        await expect(createButton.getByText('新建工件', { exact: true })).toBeVisible();
        await createButton.focus();
        await expect(createButton).toBeFocused();
        await createButton.press('Enter');
        await expect.poll(() => new URL(page.url()).pathname).toBe('/artifacts/new');

        await expect(page.getByRole('textbox', { name: '标题', exact: true })).toHaveCount(1);
        await expect(page.getByRole('textbox', { name: '内容', exact: true })).toHaveCount(1);
        const saveButton = page.getByRole('button', { name: '保存', exact: true });
        await expect(saveButton).toHaveCount(1);
        await saveButton.click();

        const dialog = page.getByRole('dialog', { name: '错误', exact: true });
        await expect(dialog).toBeVisible();
        await expect(dialog).toHaveAccessibleDescription('请输入标题或内容');
        await dialog.getByRole('button', { name: '确定', exact: true }).click();
        await expect(dialog).toHaveCount(0);

        await page.getByRole('textbox', { name: '标题', exact: true }).fill('隔离测试工件');
        await page.getByRole('textbox', { name: '内容', exact: true }).fill('仅用于本次隔离 E2E，环境结束后自动删除。');
        await saveButton.click();
        await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/artifacts\/[^/]+$/);

        await page.goto(authenticatedRoute('/artifacts'));
        await expect.poll(() => new URL(page.url()).pathname).toBe('/artifacts');
        await expect(page.getByText('隔离测试工件', { exact: true })).toBeVisible();
        await expect(page.getByText('新建工件', { exact: true })).toHaveCount(0);
        const artifactFab = page.getByRole('button', { name: '新建工件', exact: true });
        await expect(artifactFab).toHaveCount(1);
        await expect(artifactFab).toBeVisible();
        await page.getByRole('button', { name: '隔离测试工件', exact: true }).click();
        await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/artifacts\/[^/]+$/);

        const editButton = page.getByRole('button', { name: '编辑工件', exact: true });
        const deleteButton = page.getByRole('button', { name: '删除', exact: true });
        await expect(editButton).toHaveCount(1);
        await expect(deleteButton).toHaveCount(1);

        await editButton.click();
        await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/artifacts\/edit\/[^/]+$/);
        await expect(page.getByRole('textbox', { name: '标题', exact: true })).toHaveCount(1);
        await expect(page.getByRole('textbox', { name: '内容', exact: true })).toHaveCount(1);
        await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
        await page.goBack();

        await deleteButton.click();
        const deleteDialog = page.getByRole('dialog', { name: '删除工件？', exact: true });
        await expect(deleteDialog).toBeVisible();
        await deleteDialog.getByRole('button', { name: '取消', exact: true }).click();
        await expect(deleteDialog).toHaveCount(0);

        await deleteButton.click();
        await page.getByRole('dialog', { name: '删除工件？', exact: true })
            .getByRole('button', { name: '删除', exact: true })
            .click();
        await expect.poll(() => new URL(page.url()).pathname).toBe('/artifacts');
        await expect(page.getByText('暂无工件', { exact: true })).toBeVisible();

        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);
        expect(debugLogs).toEqual([]);
    });

    test('生成图片空态适配 800px 且不产生水平溢出', async ({ page }) => {
        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/generated-images'));

        await expect(page.getByText('还没有生成图片', { exact: true })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);
    });
});

test.describe('中文 Web 收件箱与好友语义', () => {
    test.use({ locale: 'zh-CN' });

    test('空态添加入口和好友搜索输入框具备稳定语义', async ({ page }) => {
        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/inbox'));

        await expect(page.getByText('收件箱为空', { exact: true })).toBeVisible();
        const inboxAddButton = page.getByRole('button', {
            name: '添加好友',
            exact: true,
        });
        await expect(inboxAddButton).toHaveCount(1);
        await inboxAddButton.click();
        await expect.poll(() => new URL(page.url()).pathname).toBe('/friends/search');

        const searchInput = page.getByRole('textbox', {
            name: '输入用户名搜索好友',
            exact: true,
        });
        await expect(searchInput).toHaveCount(1);
        await searchInput.click();
        await expect(searchInput).toBeFocused();

        await page.goto(authenticatedRoute('/friends'));
        await expect(page.getByText('您还没有好友', { exact: true })).toBeVisible();
        const friendsAddButton = page.getByRole('button', {
            name: '添加好友',
            exact: true,
        });
        await expect(friendsAddButton).toHaveCount(1);
        await friendsAddButton.click();
        await expect.poll(() => new URL(page.url()).pathname).toBe('/friends/search');

        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);
    });
});

test.describe('中文 Web 设置总览与开发者工具语义', () => {
    test.use({ locale: 'zh-CN' });

    test('列表入口排除装饰节点并保留业务详情，且更新日志导航正常', async ({ page }) => {
        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/settings'));

        for (const name of ['更新日志, 查看最新更新和改进', '报告问题', '隐私政策', '服务条款']) {
            await expect(page.getByRole('button', { name, exact: true })).toHaveCount(1);
        }
        await expect(page.getByRole('button', { name: /^主题设置, .+/ })).toHaveCount(1);
        await expect(page.getByRole('button', { name: /^语言切换, .+/ })).toHaveCount(1);
        await expect(page.getByRole('button', { name: /^Claude Code, (活跃|连接账户)$/ })).toHaveCount(1);
        await expect(page.getByRole('button', { name: /^GitHub, (已连接为 @.+|连接您的 GitHub 账户)$/ })).toHaveCount(1);
        await expect(page.getByRole('button', { name: /^版本, .+/ })).toHaveCount(1);

        await page.getByRole('button', { name: '更新日志, 查看最新更新和改进', exact: true }).click();
        await expect.poll(() => new URL(page.url()).pathname).toBe('/changelog');
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);

        await page.goto(authenticatedRoute('/dev'));
        for (const name of [
            '列表组件, Item、ItemGroup 和 ItemList 演示',
            '排版, 所有排版样式',
            '颜色, 调色板和主题',
            '工具视图, 工具调用可视化组件',
            '输入样式, 10+ 种不同的输入框样式',
            '模态系统, Alert、confirm 和自定义弹窗',
        ]) {
            await expect(page.getByRole('button', { name, exact: true })).toHaveCount(1);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);
    });
});

test.describe('中文 Web 安全组件演示主题与语义', () => {
    test.use({ locale: 'zh-CN' });

    test('排版、颜色和闪烁页跟随深色主题，列表开关有名称且可恢复', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/settings/appearance'));
        await page.getByText('Terminal', { exact: true }).click();

        for (const demo of [
            {
                path: '/dev/typography',
                screen: 'dev-typography-screen',
                heading: 'dev-typography-heading',
                background: 'rgb(19, 19, 22)',
                secondary: 'dev-typography-secondary',
                elevated: 'dev-typography-elevated',
                elevatedBackground: 'rgb(24, 24, 28)',
            },
            {
                path: '/dev/colors',
                screen: 'dev-colors-screen',
                heading: 'dev-colors-heading',
                background: 'rgb(19, 19, 22)',
                elevated: 'dev-colors-elevated',
                elevatedBackground: 'rgb(24, 24, 28)',
            },
            {
                path: '/dev/shimmer-demo',
                screen: 'dev-shimmer-screen',
                heading: 'dev-shimmer-heading',
                background: 'rgb(10, 10, 11)',
                secondary: 'dev-shimmer-secondary',
                elevated: 'dev-shimmer-elevated',
                elevatedBackground: 'rgb(19, 19, 22)',
            },
        ]) {
            await page.goto(authenticatedRoute(demo.path));
            const screen = page.getByTestId(demo.screen);
            const heading = page.getByTestId(demo.heading);
            await expect(screen).toBeVisible();
            await expect(screen).toHaveCSS('background-color', demo.background);
            await expect(heading).toHaveCSS('color', 'rgb(229, 229, 231)');
            if (demo.secondary) {
                await expect(page.getByTestId(demo.secondary)).toHaveCSS('color', 'rgb(107, 107, 118)');
            }
            await expect(page.getByTestId(demo.elevated)).toHaveCSS(
                'background-color',
                demo.elevatedBackground,
            );
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);
        }

        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto(authenticatedRoute('/dev/typography'));
        await expect(page.getByTestId('dev-typography-screen')).toHaveCSS(
            'background-color',
            'rgb(255, 255, 255)',
        );
        await expect(page.getByTestId('dev-typography-heading')).toHaveCSS('color', 'rgb(22, 32, 26)');
        await expect(page.getByTestId('dev-typography-secondary')).toHaveCSS('color', 'rgb(107, 122, 112)');
        await expect(page.getByTestId('dev-typography-elevated')).toHaveCSS(
            'background-color',
            'rgb(237, 241, 237)',
        );

        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto(authenticatedRoute('/dev/list-demo'));
        const toggle = page.getByRole('switch', { name: '开关', exact: true });
        await expect(toggle).toHaveCount(1);
        await expect(toggle).not.toBeChecked();
        await toggle.click();
        await expect(toggle).toBeChecked();
        await toggle.click();
        await expect(toggle).not.toBeChecked();

        await page.goto(authenticatedRoute('/settings/appearance'));
        await page.getByText('Caramel', { exact: true }).click();
        await page.goto(authenticatedRoute('/dev/typography'));
        await expect(page.getByTestId('dev-typography-screen')).toHaveCSS(
            'background-color',
            'rgb(36, 28, 23)',
        );
    });
});

test.describe('中文 Web 消息与工具演示', () => {
    test.use({ locale: 'zh-CN' });

    test('[STANDALONE-TOOL] 单条终端调用复用紧凑折叠行', async ({ page }, testInfo) => {
        await page.setViewportSize({ width: 1100, height: 820 });
        const url = new URL(authenticatedRoute('/dev/messages-demo'));
        url.searchParams.set('demo', 'activity-status');
        await page.goto(url.toString());

        const skillRow = page.getByTestId('activity-skill-obsidian-tools:ob-chat');
        const command = page.getByText('DEMO_RENDER_ANIMATION=0 ./render_demo.sh', { exact: true });
        await expect(skillRow).toBeVisible();

        if (standaloneToolEvidencePhase === 'before') {
            await expect(page.getByText('终端', { exact: true })).toBeVisible();
            await expect(command).toBeVisible();
            await expect(page.getByText('执行了 1 个命令', { exact: true })).toHaveCount(0);
        } else {
            const compactGroup = page.getByText('执行了 1 个命令', { exact: true });
            await expect(compactGroup).toBeVisible();
            await expect(command).toHaveCount(0);

            const compactRowHeight = await compactGroup.locator('..').evaluate((element) => (
                element.getBoundingClientRect().height
            ));
            const skillRowHeight = await skillRow.evaluate((element) => element.getBoundingClientRect().height);
            expect(Math.abs(compactRowHeight - skillRowHeight)).toBeLessThanOrEqual(2);
        }

        expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);
        await page.screenshot({
            path: standaloneToolScreenshotPath(testInfo),
            fullPage: true,
        });
    });

    test('对话明确展示 Skill 名称与子 Agent 生命周期状态', async ({ page }, testInfo) => {
        await page.setViewportSize({ width: 1100, height: 820 });
        const url = new URL(authenticatedRoute('/dev/messages-demo'));
        url.searchParams.set('demo', 'activity-status');
        await page.goto(url.toString());

        const skill = page.getByTestId('activity-skill-obsidian-tools:ob-chat');
        await expect(skill).toHaveCount(1);
        await expect(skill).toContainText('技能（Skill）');
        await expect(skill).toContainText('obsidian-tools:ob-chat');
        await expect(skill).toContainText('已完成');
        const runningAgent = page.getByTestId('activity-subagent-ax389dhoj1bran7p3s3fdh6n');
        const completedAgent = page.getByTestId('activity-subagent-yghxp0tj8cat500passf65pq');
        const nestedSkill = page.getByTestId('activity-skill-dev');
        await expect(runningAgent).toHaveCount(1);
        await expect(completedAgent).toHaveCount(1);
        await expect(nestedSkill).toHaveCount(1);
        await expect(runningAgent).toContainText('子 Agent');
        await expect(runningAgent).toContainText('进行中');
        await expect(completedAgent).toContainText('子 Agent');
        await expect(completedAgent).toContainText('已完成');
        const runningIndent = await runningAgent.evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingLeft));
        const completedIndent = await completedAgent.evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingLeft));
        const nestedSkillIndent = await nestedSkill.evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingLeft));
        expect(completedIndent).toBeGreaterThan(runningIndent);
        expect(nestedSkillIndent).toBeGreaterThan(runningIndent);
        const parentPrecedesNestedSkill = await runningAgent.evaluate((element) => {
            const nested = document.querySelector('[data-testid="activity-skill-dev"]');
            return nested !== null
                && Boolean(element.compareDocumentPosition(nested) & Node.DOCUMENT_POSITION_FOLLOWING);
        });
        expect(parentPrecedesNestedSkill).toBe(true);

        const nestedToolGroupToggle = page.getByText(/使用的 Skills.*obsidian-tools:ob-chat/).last();
        await expect(nestedToolGroupToggle).toBeVisible();
        await nestedToolGroupToggle.click();
        await expect(skill).toHaveCount(1);
        await expect(nestedSkill).toHaveCount(1);
        await expect(runningAgent).toHaveCount(1);
        await expect(completedAgent).toHaveCount(1);

        await page.screenshot({
            path: testInfo.outputPath('chat-activity-status-after.png'),
            fullPage: true,
        });
    });

    test('[SUBAGENT-INSPECTOR] 子 Agent 活动行在桌面右栏和手机抽屉展示隔离记录', async ({ page, request }, testInfo) => {
        const parentSubagent = 'ax389dhoj1bran7p3s3fdh6n';
        const nestedSubagent = 'yghxp0tj8cat500passf65pq';
        const turn = 'subagent-inspector-turn';
        const sessionId = await createE2ESession(request, {
            name: 'Sub-agent inspector E2E',
            summary: 'Parent and nested agent transcript fixture',
        });
        const baseTime = Date.now() - 30_000;

        const envelopes = [
            {
                id: 'subagent-root-intro',
                time: baseTime,
                role: 'agent',
                turn,
                ev: { t: 'text', text: 'Root conversation context must stay outside the inspector.' },
            },
            {
                id: 'subagent-parent-call',
                time: baseTime + 1_000,
                role: 'agent',
                turn,
                ev: {
                    t: 'tool-call-start',
                    call: 'subagent-parent-call',
                    name: 'Agent',
                    title: 'Spawn implementation agent',
                    description: 'Implementation agent',
                    args: {
                        description: 'Implementation agent',
                        prompt: 'Implement the authorization change and ask a review agent to verify it.',
                        sessionSubagent: parentSubagent,
                    },
                },
            },
            {
                id: 'subagent-parent-start',
                time: baseTime + 2_000,
                role: 'agent',
                turn,
                subagent: parentSubagent,
                ev: { t: 'start', title: 'Implementation agent' },
            },
            {
                id: 'subagent-parent-text',
                time: baseTime + 3_000,
                role: 'agent',
                turn,
                subagent: parentSubagent,
                ev: { t: 'text', text: 'Parent agent visible summary.' },
            },
            {
                id: 'subagent-parent-hidden-reasoning',
                time: baseTime + 3_500,
                role: 'agent',
                turn,
                subagent: parentSubagent,
                ev: { t: 'text', text: 'Private parent reasoning must stay hidden.', thinking: true },
            },
            {
                id: 'subagent-parent-bash-call',
                time: baseTime + 4_000,
                role: 'agent',
                turn,
                subagent: parentSubagent,
                ev: {
                    t: 'tool-call-start',
                    call: 'subagent-parent-bash-call',
                    name: 'Bash',
                    title: 'Run focused tests',
                    description: 'Run focused tests',
                    args: { command: 'pnpm --filter happy-app test' },
                },
            },
            {
                id: 'subagent-parent-bash-end',
                time: baseTime + 5_000,
                role: 'agent',
                turn,
                subagent: parentSubagent,
                ev: { t: 'tool-call-end', call: 'subagent-parent-bash-call', status: 'completed' },
            },
            {
                id: 'subagent-nested-call',
                time: baseTime + 6_000,
                role: 'agent',
                turn,
                subagent: parentSubagent,
                ev: {
                    t: 'tool-call-start',
                    call: 'subagent-nested-call',
                    name: 'Agent',
                    title: 'Spawn review agent',
                    description: 'Review agent',
                    args: {
                        description: 'Review agent',
                        prompt: 'Review the authorization changes in packages/happy-app/sources/api/review.ts. Inspect callers, run focused tests, and report findings with severity plus file and line references. Do not edit files.',
                        sessionSubagent: nestedSubagent,
                    },
                },
            },
            {
                id: 'subagent-nested-start',
                time: baseTime + 7_000,
                role: 'agent',
                turn,
                subagent: nestedSubagent,
                ev: { t: 'start', title: 'Review agent' },
            },
            {
                id: 'subagent-nested-progress',
                time: baseTime + 8_000,
                role: 'agent',
                turn,
                subagent: nestedSubagent,
                ev: { t: 'text', text: 'Checking the authorization boundary and every caller before reporting findings.' },
            },
            {
                id: 'subagent-nested-hidden-reasoning',
                time: baseTime + 8_500,
                role: 'agent',
                turn,
                subagent: nestedSubagent,
                ev: { t: 'text', text: 'Private review reasoning must stay hidden.', thinking: true },
            },
            {
                id: 'subagent-review-read-call',
                time: baseTime + 9_000,
                role: 'agent',
                turn,
                subagent: nestedSubagent,
                ev: {
                    t: 'tool-call-start',
                    call: 'subagent-review-read-call',
                    name: 'Read',
                    title: 'Read authorization handler',
                    description: 'Read authorization handler',
                    args: {
                        file_path: 'packages/happy-app/sources/api/review.ts',
                        offset: 32,
                        limit: 36,
                    },
                },
            },
            {
                id: 'subagent-review-read-end',
                time: baseTime + 10_000,
                role: 'agent',
                turn,
                subagent: nestedSubagent,
                ev: { t: 'tool-call-end', call: 'subagent-review-read-call', status: 'completed' },
            },
            {
                id: 'subagent-review-grep-call',
                time: baseTime + 11_000,
                role: 'agent',
                turn,
                subagent: nestedSubagent,
                ev: {
                    t: 'tool-call-start',
                    call: 'subagent-review-grep-call',
                    name: 'Grep',
                    title: 'Find authorization guards',
                    description: 'Find authorization guards',
                    args: {
                        pattern: 'authorize|requireSession',
                        path: 'packages/happy-app/sources/api',
                        output_mode: 'content',
                        '-n': true,
                    },
                },
            },
            {
                id: 'subagent-review-grep-end',
                time: baseTime + 12_000,
                role: 'agent',
                turn,
                subagent: nestedSubagent,
                ev: { t: 'tool-call-end', call: 'subagent-review-grep-call', status: 'completed' },
            },
            {
                id: 'subagent-review-bash-call',
                time: baseTime + 13_000,
                role: 'agent',
                turn,
                subagent: nestedSubagent,
                ev: {
                    t: 'tool-call-start',
                    call: 'subagent-review-bash-call',
                    name: 'Bash',
                    title: 'Run focused authorization tests',
                    description: 'Run focused authorization tests',
                    args: { command: 'pnpm --filter happy-app test --run authorization.test.ts' },
                },
            },
            {
                id: 'subagent-review-bash-end',
                time: baseTime + 14_000,
                role: 'agent',
                turn,
                subagent: nestedSubagent,
                ev: { t: 'tool-call-end', call: 'subagent-review-bash-call', status: 'completed' },
            },
            {
                id: 'subagent-nested-finding',
                time: baseTime + 15_000,
                role: 'agent',
                turn,
                subagent: nestedSubagent,
                ev: {
                    t: 'text',
                    text: '[P1] Missing authorization guard - packages/happy-app/sources/api/review.ts:42\nThe new handler trusts the request owner before requireSession runs, so another signed-in user can read the review. Add the same requireSession ownership check used by the sibling endpoint.',
                },
            },
            {
                id: 'subagent-nested-stop',
                time: baseTime + 16_000,
                role: 'agent',
                turn,
                subagent: nestedSubagent,
                ev: { t: 'stop', status: 'completed' },
            },
            {
                id: 'subagent-nested-call-end',
                time: baseTime + 17_000,
                role: 'agent',
                turn,
                subagent: parentSubagent,
                ev: { t: 'tool-call-end', call: 'subagent-nested-call', status: 'completed' },
            },
            {
                id: 'subagent-parent-stop',
                time: baseTime + 18_000,
                role: 'agent',
                turn,
                subagent: parentSubagent,
                ev: { t: 'stop', status: 'completed' },
            },
            {
                id: 'subagent-parent-call-end',
                time: baseTime + 19_000,
                role: 'agent',
                turn,
                ev: { t: 'tool-call-end', call: 'subagent-parent-call', status: 'completed' },
            },
            {
                id: 'subagent-root-final',
                time: baseTime + 20_000,
                role: 'agent',
                turn,
                ev: { t: 'text', text: 'Root final answer must stay outside the inspector.' },
            },
        ];

        await page.setViewportSize({ width: 1280, height: 720 });
        await page.goto(authenticatedRoute(`/session/${sessionId}`));
        const messageInput = page.getByTestId('session-message-input');
        try {
            await expect(messageInput).toBeVisible({ timeout: 20_000 });
        } catch {
            await page.reload();
            await expect(messageInput).toBeVisible({ timeout: 90_000 });
        }
        await appendE2ESessionEnvelopes(request, sessionId, envelopes.slice(0, 2));
        await expect(page.getByText('Root conversation context must stay outside the inspector.', { exact: true }))
            .toBeVisible({ timeout: 30_000 });
        await appendE2ESessionEnvelopes(request, sessionId, envelopes.slice(2, 8));
        const parentRow = page.locator(`[data-testid="activity-subagent-${parentSubagent}"]:visible`).first();
        const desktopPanel = page.locator('[data-testid="desktop-right-panel"]:visible');
        await expect(parentRow).toBeVisible({ timeout: 30_000 });
        await appendE2ESessionEnvelopes(request, sessionId, envelopes.slice(8));
        await expect(page.getByText('Root final answer must stay outside the inspector.', { exact: true }))
            .toBeVisible({ timeout: 30_000 });
        await expect(parentRow).toHaveAttribute('role', 'button');
        await expect(parentRow).toHaveAttribute('aria-expanded', 'false');
        await expect(desktopPanel).toContainText('能力中心');
        await page.screenshot({
            path: subagentInspectorScreenshotPath(testInfo, 'subagent-inspector-desktop-before.png'),
            fullPage: true,
        });

        await parentRow.click();
        const inspector = page.locator('[data-testid="subagent-inspector-panel"]:visible');
        await expect(inspector).toBeVisible();
        await expect(inspector.getByTestId('subagent-inspector-title')).toHaveText('Implementation agent');
        await expect(inspector.getByTestId('subagent-inspector-status')).toHaveText('已完成');
        await expect(inspector.getByTestId('subagent-inspector-task')).toHaveText(
            'Implement the authorization change and ask a review agent to verify it.',
        );
        await expect(inspector.getByText('Parent agent visible summary.', { exact: true })).toBeVisible();
        await expect(inspector.getByText('pnpm --filter happy-app test', { exact: true })).toBeVisible();
        await expect(inspector.getByText('Private parent reasoning must stay hidden.', { exact: true })).toHaveCount(0);
        await expect(inspector.getByText('Root final answer must stay outside the inspector.', { exact: true })).toHaveCount(0);
        await expect(page.locator('[data-testid="desktop-right-panel-toggle-button"]:visible'))
            .toHaveAttribute('aria-label', '收起子 Agent「Implementation agent」详情');
        const nestedRow = inspector.getByTestId(`activity-subagent-${nestedSubagent}`);
        await expect(nestedRow).toBeVisible();
        await nestedRow.click();
        await expect(inspector.getByTestId('subagent-inspector-title')).toHaveText('Review agent');
        await expect(inspector.getByTestId('subagent-inspector-task')).toContainText(
            'Review the authorization changes in packages/happy-app/sources/api/review.ts.',
        );
        await expect(inspector.getByText(
            'Checking the authorization boundary and every caller before reporting findings.',
            { exact: true },
        )).toBeVisible();
        await expect(inspector.getByText('packages/happy-app/sources/api/review.ts', { exact: true })).toBeVisible();
        await expect(inspector.getByText('grep(pattern: authorize|requireSession)', { exact: true })).toBeVisible();
        await expect(inspector.getByText(
            'pnpm --filter happy-app test --run authorization.test.ts',
            { exact: true },
        )).toBeVisible();
        await expect(inspector.getByText(/\[P1\] Missing authorization guard/)).toBeVisible();
        await expect(inspector.getByText('Private review reasoning must stay hidden.', { exact: true })).toHaveCount(0);
        await expect(inspector.getByText('Parent agent visible summary.', { exact: true })).toHaveCount(0);
        await expect(inspector.getByText('Root final answer must stay outside the inspector.', { exact: true })).toHaveCount(0);
        await pauseForRecordedReview(page, 900);
        await page.screenshot({
            path: subagentInspectorScreenshotPath(testInfo, 'subagent-inspector-desktop-after.png'),
            fullPage: true,
        });

        await inspector.getByTestId('subagent-inspector-back').click();
        await expect(inspector).toHaveCount(0);
        await expect(desktopPanel).toBeVisible();
        await expect(desktopPanel).toContainText('能力中心');

        await page.setViewportSize({ width: 390, height: 844 });
        await expect(page.locator('[data-testid="right-swipe-panel-host"]:visible')).toBeVisible();
        await expect(page.getByTestId('right-swipe-panel-edge-handle')).toHaveCount(0);
        await expect(desktopPanel).toHaveCount(0);
        await expect(parentRow).toBeVisible();
        const mobileParentRowBox = await parentRow.boundingBox();
        expect(mobileParentRowBox).not.toBeNull();
        expect(mobileParentRowBox!.x).toBeGreaterThanOrEqual(0);
        expect(mobileParentRowBox!.x + mobileParentRowBox!.width).toBeLessThanOrEqual(390);
        await page.screenshot({
            path: subagentInspectorScreenshotPath(testInfo, 'subagent-inspector-mobile-before.png'),
        });
        const mobileReviewRow = page.locator(`[data-testid="activity-subagent-${nestedSubagent}"]:visible`).first();
        await expect(mobileReviewRow).toBeVisible();
        await mobileReviewRow.click();
        const drawer = page.locator('[data-testid="right-swipe-panel-drawer"]:visible');
        await expect(drawer).toHaveAttribute('role', 'dialog');
        await expect(drawer.getByTestId('subagent-inspector-panel')).toBeVisible();
        const drawerBox = await drawer.boundingBox();
        expect(drawerBox).not.toBeNull();
        expect(drawerBox!.x).toBe(0);
        expect(drawerBox!.width).toBe(390);
        await expect(drawer.getByTestId('subagent-inspector-title')).toHaveText('Review agent');
        await expect(drawer.getByTestId('subagent-inspector-task')).toContainText(
            'Review the authorization changes in packages/happy-app/sources/api/review.ts.',
        );
        await expect(drawer.getByText(/\[P1\] Missing authorization guard/)).toBeVisible();
        await expect(drawer.getByText('Parent agent visible summary.', { exact: true })).toHaveCount(0);
        await expect(page.getByTestId('right-swipe-panel-edge-handle')).toHaveCount(0);
        await expect(drawer.getByTestId('right-swipe-panel-close-button'))
            .toHaveAttribute('aria-label', '收起子 Agent「Review agent」详情');
        await pauseForRecordedReview(page, 1_000);
        await page.screenshot({
            path: subagentInspectorScreenshotPath(testInfo, 'subagent-inspector-mobile-after.png'),
        });

        await drawer.getByTestId('right-swipe-panel-close-button').click();
        await expect(page.getByTestId('subagent-inspector-panel')).toHaveCount(0);
        await expect(page.getByTestId('session-message-input')).toBeVisible();
        await page.close();
    });

    test('[MP4-AGENT] send_file 输出直接呈现裸视频并支持播放与跳播', async ({ page }, testInfo) => {
        const fixturePath = process.env.HAPPY_E2E_MP4_PATH;
        if (!fixturePath) throw new Error('缺少 HAPPY_E2E_MP4_PATH');
        const fixture = fs.readFileSync(fixturePath);
        await page.route('**/v1/sessions/demo-messages-session/attachments/request-download', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ downloadUrl: 'https://files.test/agent-output.mp4?X-Amz-Signature=e2e' }),
            });
        });
        await page.route('https://files.test/agent-output.mp4**', (route) => fulfillMp4Route(route, fixture));

        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/dev/messages-demo'));
        await expect(page.getByTestId('media-attachment-player-generated')).toBeVisible();
        await expect(page.getByTestId('media-attachment-card-generated')).toHaveCount(0);
        await expect(page.getByTestId('media-attachment-player-generated-fullscreen')).toHaveCount(0);
        await expect(page.getByText('agent-output.mp4', { exact: true })).toHaveCount(0);
        await expect(page.getByText('file', { exact: true })).toHaveCount(0);

        await exerciseInlineVideo(page, 'media-attachment-player-generated');
        await pauseForRecordedReview(page, 1_100);
        await page.screenshot({ path: testInfo.outputPath('mp4-agent-after.png'), fullPage: true });
    });

    test('[MP4-USER] 选择与发送 MP4 前后均直接呈现裸视频', async ({ page, request }, testInfo) => {
        const fixturePath = process.env.HAPPY_E2E_MP4_PATH;
        if (!fixturePath) throw new Error('缺少 HAPPY_E2E_MP4_PATH');
        const sessionId = await createE2ESession(request);

        await page.setViewportSize({ width: 1280, height: 720 });
        await page.goto(authenticatedRoute(`/session/${sessionId}`));
        await expect(page.getByTestId('session-message-input')).toBeVisible();

        await page.getByRole('button', { name: /添加附件|Add attachment/i }).click();
        const fileChooserPromise = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: /音频.*视频|Audio or video/i }).click();
        const fileChooser = await fileChooserPromise;
        await fileChooser.setFiles(fixturePath);

        await expect(page.getByTestId('media-attachment-player-pending')).toBeVisible();
        await expect(page.getByTestId('media-attachment-card-pending')).toHaveCount(0);
        await expect(page.getByTestId('media-attachment-player-pending-fullscreen')).toHaveCount(0);
        await expect(page.getByText(path.basename(fixturePath), { exact: true })).toHaveCount(0);

        await exerciseInlineVideo(page, 'media-attachment-player-pending');
        await page.locator('[data-testid="message-composer-send-button"]:not([aria-disabled="true"])').click();

        await expect(page.getByTestId('media-attachment-player-user')).toBeVisible({ timeout: 20_000 });
        await expect(page.getByTestId('media-attachment-card-user')).toHaveCount(0);
        await expect(page.getByTestId('media-attachment-player-user-fullscreen')).toHaveCount(0);
        await exerciseInlineVideo(page, 'media-attachment-player-user');
        await pauseForRecordedReview(page, 1_100);
        await page.screenshot({ path: testInfo.outputPath('mp4-user-after.png'), fullPage: true });
    });

    test('[MOTION-01] 荣耀动态 JPEG 以静态图进入查看器并按需播放内嵌视频', async ({ page, request }, testInfo) => {
        test.setTimeout(120_000);
        const fixturePath = process.env.HAPPY_E2E_MOTION_PHOTO_PATH;
        if (!fixturePath) throw new Error('缺少 HAPPY_E2E_MOTION_PHOTO_PATH');
        const sessionId = await createE2ESession(request, {
            name: 'Honor motion photo E2E',
            summary: 'Honor motion photo E2E',
        });

        await page.setViewportSize({ width: 1280, height: 720 });
        await page.goto(authenticatedRoute(`/session/${sessionId}`));
        await expect(page.getByRole('textbox', { name: /输入消息|Type a message/i })).toBeVisible({ timeout: 20_000 });

        await page.getByRole('button', { name: /添加附件|Add attachment/i }).click();
        const fileChooserPromise = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: /图片|Photo or image/i }).click();
        const fileChooser = await fileChooserPromise;
        await fileChooser.setFiles(fixturePath);
        const sendButton = page.locator('[data-testid="message-composer-send-button"]:not([aria-disabled="true"])');
        await expect(sendButton).toBeVisible({ timeout: 20_000 });
        await sendButton.click();

        if (motionPhotoEvidencePhase === 'before') {
            await expect(page.getByTestId('attachment-gallery-image')).toBeVisible({ timeout: 20_000 });
            await expect(page.getByTestId('motion-photo-cover')).toHaveCount(0);
            await page.screenshot({ path: motionPhotoScreenshotPath(testInfo), fullPage: true });
            return;
        }

        const cover = page.getByTestId('motion-photo-cover');
        await expect(cover).toBeVisible({ timeout: 20_000 });
        await expect(page.getByTestId('motion-photo-viewer-player')).toHaveCount(0);
        await expect(page.getByTestId('motion-photo-viewer-toggle')).toHaveCount(0);
        await expect(page.getByTestId('attachment-gallery-image')).toHaveCount(0);
        await expect(page.getByText('file', { exact: true })).toHaveCount(0);
        const downloadButton = page.getByTestId('motion-photo-download');
        await expect(downloadButton).toBeVisible();
        await expect(downloadButton).toHaveAttribute('aria-label', /下载原始动态照片|Download original motion photo/i);
        await downloadButton.hover();
        await expect(page.getByTestId('motion-photo-download-tooltip')).toBeVisible();
        await pauseForRecordedReview(page, 1_000);
        await page.screenshot({ path: motionPhotoScreenshotPath(testInfo), fullPage: true });
        await cover.hover();
        await expect(page.getByTestId('motion-photo-download-tooltip')).toHaveCount(0);

        const downloadPromise = page.waitForEvent('download');
        await downloadButton.click();
        const download = await downloadPromise;
        expect(download.suggestedFilename()).toBe(path.basename(fixturePath));
        const downloadedPath = await download.path();
        if (!downloadedPath) throw new Error('浏览器没有保留动态照片下载文件');
        expect(fs.readFileSync(downloadedPath).equals(fs.readFileSync(fixturePath))).toBe(true);
        await pauseForRecordedReview(page, 850);

        await page.setViewportSize({ width: 390, height: 844 });
        await expect(downloadButton).toBeVisible();
        await expect.poll(() => cover.locator('img').evaluateAll((images) => images.some((image) => (
            (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0
        ))), { timeout: 20_000 }).toBe(true);
        const mobileDownloadBox = await downloadButton.boundingBox();
        if (!mobileDownloadBox) throw new Error('找不到窄屏动态照片下载入口');
        expect(mobileDownloadBox.width).toBeGreaterThanOrEqual(48);
        expect(mobileDownloadBox.height).toBeGreaterThanOrEqual(48);
        expect(mobileDownloadBox.x).toBeGreaterThanOrEqual(0);
        expect(mobileDownloadBox.x + mobileDownloadBox.width).toBeLessThanOrEqual(390);
        await page.screenshot({ path: motionPhotoScreenshotPath(testInfo, 'mobile'), fullPage: true });
        await pauseForRecordedReview(page, 850);

        await page.setViewportSize({ width: 1280, height: 720 });
        await expect(cover).toBeVisible();

        await cover.click();
        await expect(page.getByTestId('image-viewer')).toBeVisible();
        await expect(page.getByTestId('image-viewer-image')).toBeVisible();
        const motionToggle = page.getByTestId('motion-photo-viewer-toggle');
        await expect(motionToggle).toBeVisible();
        await expect(motionToggle).toHaveAttribute('aria-label', /播放动态照片|Play motion photo/i);
        await motionToggle.hover();
        await expect(page.getByTestId('motion-photo-viewer-tooltip')).toContainText(/播放动态照片|Play motion photo/i);
        await motionToggle.focus();
        await page.mouse.move(640, 500);
        await expect(page.getByTestId('motion-photo-viewer-tooltip')).toBeVisible();
        await expect(page.getByTestId('motion-photo-viewer-player')).toHaveCount(0);

        await motionToggle.press('Enter');
        const player = page.getByTestId('motion-photo-viewer-player');
        const video = player.locator('video');
        await expect(player).toBeVisible({ timeout: 20_000 });
        await expect(motionToggle).toHaveAttribute('aria-label', /停止动态照片|Stop motion photo/i);
        await expect(page.getByTestId('motion-photo-viewer-tooltip')).toContainText(/停止动态照片|Stop motion photo/i);
        await expect.poll(() => video.evaluate((element) => {
            const media = element as HTMLVideoElement;
            return media.readyState >= HTMLMediaElement.HAVE_METADATA && media.duration > 1;
        }), { timeout: 20_000 }).toBe(true);
        const videoBox = await video.boundingBox();
        if (!videoBox) throw new Error('找不到动态照片视频的原生播放控件区域');
        await video.evaluate((element) => {
            (element as HTMLVideoElement).muted = true;
        });
        await video.click({ position: { x: 24, y: videoBox.height - 48 } });
        await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).paused)).toBe(false);
        await pauseForRecordedReview(page, 1_800);
        await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0.5);
        await video.evaluate((element) => (element as HTMLVideoElement).pause());
        await page.close();
    });

    test('[PDF-USER] 选择、加密发送并重新下载原始 PDF', async ({ page, request }, testInfo) => {
        test.setTimeout(120_000);
        const fileName = '室内平面图-e2e.pdf';
        const fixture = Buffer.from([
            '%PDF-1.4',
            '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
            '2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj',
            'trailer << /Root 1 0 R >>',
            '%%EOF',
            '',
        ].join('\n'), 'utf8');
        const sessionId = await createE2ESession(request, {
            name: 'PDF attachment E2E',
            summary: 'PDF attachment E2E',
        });

        await page.setViewportSize({ width: 1280, height: 720 });
        await page.goto(authenticatedRoute(`/session/${sessionId}`));
        await expect(page.getByTestId('session-message-input')).toBeVisible();

        await page.getByRole('button', { name: /添加附件|Add attachment/i }).click();
        const fileChooserPromise = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: /PDF 文档|PDF document/i }).click();
        const fileChooser = await fileChooserPromise;
        expect(await fileChooser.element().getAttribute('accept')).toBe('application/pdf');
        await fileChooser.setFiles({
            name: fileName,
            mimeType: 'application/pdf',
            buffer: fixture,
        });

        const pendingCard = page.getByTestId('document-attachment-card-pending');
        await expect(pendingCard).toBeVisible();
        await expect(pendingCard).toContainText(fileName);
        await expect(pendingCard).toContainText('PDF 文档');
        await pauseForRecordedReview(page, 1_000);

        await page.locator('[data-testid="message-composer-send-button"]:not([aria-disabled="true"])').click();

        const sentCard = page.getByTestId('document-attachment-card-user');
        await expect(sentCard).toBeVisible({ timeout: 20_000 });
        await expect(sentCard).toContainText(fileName);
        await expect(sentCard).toContainText(`${fixture.length}B`);
        await expect(pendingCard).toHaveCount(0);

        await expect.poll(
            () => readE2EFileEvent(request, sessionId, fileName),
            { timeout: 20_000 },
        ).toMatchObject({
            t: 'file',
            name: fileName,
            size: fixture.length,
            kind: 'file',
            mimeType: 'application/pdf',
        });
        const fileEvent = await readE2EFileEvent(request, sessionId, fileName);
        if (!fileEvent) throw new Error('PDF 文件事件未写入本地 E2E Server');
        expect(fileEvent.encrypted).not.toBe(false);
        expect(fileEvent.ref).toMatch(/^sessions\/.+\/attachments\/.+\.enc$/);

        const encryptedBlob = await downloadE2EAttachment(request, sessionId, fileEvent.ref);
        expect(encryptedBlob.equals(fixture)).toBe(false);
        expect(encryptedBlob.includes(Buffer.from('%PDF-1.4', 'utf8'))).toBe(false);
        expect(encryptedBlob.length).toBe(fixture.length + 40);

        const authUrl = new URL(authenticatedWebUrl);
        const secret = authUrl.searchParams.get('dev_secret');
        if (!secret) throw new Error('缺少解密 E2E PDF 所需的本地密钥');
        const masterSecret = new Uint8Array(Buffer.from(secret, 'base64url'));
        const blobKey = await deriveKey(masterSecret, 'Happy Blobs', ['master']);
        const decryptedBlob = decryptBlob(new Uint8Array(encryptedBlob), blobKey);
        expect(decryptedBlob).not.toBeNull();
        expect(Buffer.from(decryptedBlob!)).toEqual(fixture);

        await page.reload();
        await expect(page.getByTestId('session-message-input')).toBeVisible();
        await expect(sentCard).toBeVisible({ timeout: 20_000 });
        await expect(sentCard).toContainText(fileName);
        await expect(sentCard).toContainText(`${fixture.length}B`);

        // The operating-system Web Share sheet is outside Playwright's control.
        // Model a browser without file sharing so this E2E exercises the real
        // user-visible download fallback instead of hanging on the native sheet.
        await page.evaluate(() => {
            const scope = globalThis as typeof globalThis & { __pdfE2EShareCalls: number };
            scope.__pdfE2EShareCalls = 0;
            Object.defineProperty(navigator, 'share', {
                configurable: true,
                value: async () => {
                    scope.__pdfE2EShareCalls += 1;
                },
            });
            Object.defineProperty(navigator, 'canShare', {
                configurable: true,
                value: () => false,
            });
        });
        const browserDownload = page.waitForEvent('download');
        await sentCard.click();
        const downloadedPdf = await browserDownload;
        expect(downloadedPdf.suggestedFilename()).toBe(fileName);
        const downloadedPath = await downloadedPdf.path();
        if (!downloadedPath) throw new Error('浏览器没有保留下载后的 E2E PDF');
        expect(fs.readFileSync(downloadedPath)).toEqual(fixture);
        expect(await page.evaluate(
            () => (globalThis as typeof globalThis & { __pdfE2EShareCalls: number }).__pdfE2EShareCalls,
        )).toBe(0);

        await pauseForRecordedReview(page, 1_100);
        await page.screenshot({ path: testInfo.outputPath('pdf-user-after.png'), fullPage: true });
    });

    test('宽屏图片消息与正文阅读列对齐，不再横向铺满', async ({ page }) => {
        await page.setViewportSize({ width: 1600, height: 900 });
        await page.goto(authenticatedRoute('/dev/messages-demo'));

        const host = page.getByTestId('dev-featured-gallery-host');
        const gallery = page.getByTestId('attachment-gallery-featured');
        await expect(host).toBeVisible();
        await expect(gallery).toBeVisible();

        const layout = await host.evaluate((hostElement) => {
            const galleryElement = hostElement.querySelector(
                '[data-testid="attachment-gallery-featured"]',
            );
            if (!(galleryElement instanceof HTMLElement)) {
                throw new Error('找不到特色图片消息容器');
            }
            const hostRect = hostElement.getBoundingClientRect();
            const galleryRect = galleryElement.getBoundingClientRect();
            return {
                hostWidth: hostRect.width,
                galleryWidth: galleryRect.width,
                leftGap: galleryRect.left - hostRect.left,
                rightGap: hostRect.right - galleryRect.right,
            };
        });

        expect(layout.hostWidth).toBeGreaterThan(800);
        expect(layout.galleryWidth).toBeLessThanOrEqual(800);
        expect(Math.abs(layout.leftGap - layout.rightGap)).toBeLessThanOrEqual(1);
    });

    test('消息表格与代码在窄屏内横向滚动，图片操作具备名称', async ({ page }) => {
        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/dev/messages-demo'));

        const tableScroll = page.getByTestId('markdown-table-scroll').first();
        const codeScroll = page.getByTestId('markdown-code-scroll').first();
        await expect(tableScroll).toBeVisible();
        await expect(codeScroll).toBeVisible();

        for (const scrollArea of [tableScroll, codeScroll]) {
            const dimensions = await scrollArea.evaluate((element) => ({
                clientWidth: element.clientWidth,
                scrollWidth: element.scrollWidth,
            }));
            expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.clientWidth);
        }

        await expect(page.getByRole('button', {
            name: 'Markdown renderable image',
            exact: true,
        })).toHaveCount(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);
    });

    test('工具页跟随深色主题并让七组筛选呈现完整示例', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/settings/appearance'));
        await page.getByText('Terminal', { exact: true }).click();
        await page.goto(authenticatedRoute('/dev/tools2'));

        await expect(page.getByTestId('dev-tools-screen')).toHaveCSS(
            'background-color',
            'rgb(10, 10, 11)',
        );
        await expect(page.getByTestId('dev-tools-heading')).toHaveCSS('color', 'rgb(229, 229, 231)');
        await expect(page.getByTestId('dev-tools-description')).toHaveCSS('color', 'rgb(107, 107, 118)');

        for (const filter of [
            { id: 'all', keys: ['read', 'readError', 'edit', 'bash', 'bashRunning', 'bashError', 'bashLongCommand', 'bashMultiline', 'bashLargeOutput', 'bashNoOutput', 'bashWithWarnings', 'search', 'write', 'toolPending', 'toolApproved', 'toolDenied', 'toolCanceled'] },
            { id: 'read', keys: ['read', 'readError'] },
            { id: 'edit', keys: ['edit'] },
            { id: 'bash', keys: ['bash', 'bashRunning', 'bashError', 'bashLongCommand', 'bashMultiline', 'bashLargeOutput', 'bashNoOutput', 'bashWithWarnings'] },
            { id: 'other', keys: ['search', 'write'] },
            { id: 'permissions', keys: ['toolPending', 'toolApproved', 'toolDenied', 'toolCanceled'] },
            { id: 'status', keys: ['bashRunning', 'bash', 'bashError', 'toolDenied', 'toolCanceled'] },
        ]) {
            const radio = page.getByTestId(`dev-tools-filter-${filter.id}`);
            await expect(radio).toHaveAttribute('role', 'radio');
            await radio.click();
            await expect(radio).toHaveAttribute('aria-checked', 'true');
            const renderedKeys = await page.locator('[data-testid^="dev-tool-example-"]')
                .evaluateAll((elements) => elements.map((element) => (
                    element.getAttribute('data-testid')?.replace('dev-tool-example-', '')
                )));
            expect(renderedKeys).toEqual(filter.keys);
            expect(new Set(renderedKeys).size).toBe(renderedKeys.length);
        }

        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);

        await page.goto(authenticatedRoute('/settings/appearance'));
        await page.getByText('Caramel', { exact: true }).click();
        await page.goto(authenticatedRoute('/dev/tools2'));
        await expect(page.getByTestId('dev-tools-screen')).toHaveCSS(
            'background-color',
            'rgb(26, 21, 18)',
        );
    });
});

test.describe('中文 Web 输入与倒序列表演示', () => {
    test.use({ locale: 'zh-CN' });

    test('倒序列表控件具备选择语义且 Web 不会启用 LegendList', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/settings/appearance'));
        await page.getByText('Terminal', { exact: true }).click();
        await page.goto(authenticatedRoute('/dev/inverted-list'));

        await expect(page.getByTestId('dev-inverted-list-screen')).toHaveCSS(
            'background-color',
            'rgb(10, 10, 11)',
        );
        await expect(page.getByRole('radiogroup', { name: '列表实现：' })).toHaveCount(1);
        await expect(page.getByRole('radiogroup', { name: '内边距方式：' })).toHaveCount(1);
        await expect(page.getByRole('radio')).toHaveCount(6);

        const flatList = page.getByTestId('dev-inverted-list-type-flat');
        await flatList.click();
        await expect(flatList).toHaveAttribute('aria-checked', 'true');

        const headerFooter = page.getByTestId('dev-inverted-list-padding-header-footer');
        await headerFooter.click();
        await expect(headerFooter).toHaveAttribute('aria-checked', 'true');

        const legendList = page.getByTestId('dev-inverted-list-type-legend');
        await expect(legendList).toHaveAttribute('role', 'radio');
        await expect(legendList).toHaveAttribute('aria-disabled', 'true');
        await expect(legendList).toHaveAttribute('aria-checked', 'false');
        await expect(legendList).toHaveAccessibleName('LegendList, 仅原生端可用');

        const input = page.getByRole('textbox', { name: '输入消息...' });
        const send = page.getByRole('button', { name: '发送', exact: true });
        await expect(send).toBeDisabled();
        await input.fill('本地倒序列表回归');
        await expect(send).toBeEnabled();
        await send.click();
        await expect(page.getByText('本地倒序列表回归', { exact: true })).toBeVisible();
        await expect(input).toHaveValue('');

        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);
    });

    test('多行输入与输入样式在深色主题下可操作且不会污染 Tab 顺序', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/settings/appearance'));
        await page.getByText('Terminal', { exact: true }).click();
        await page.goto(authenticatedRoute('/dev/multi-text-input'));

        await expect(page.getByTestId('dev-multi-text-input-screen')).toHaveCSS(
            'background-color',
            'rgb(10, 10, 11)',
        );
        const inputNames = [
            '基础用法',
            '带初始值',
            '限制高度（60px）',
            '更大高度（200px）',
            '键盘处理',
        ];
        for (const name of inputNames) {
            await expect(page.getByRole('textbox', { name, exact: true })).toHaveCount(1);
        }

        const basicInput = page.getByRole('textbox', { name: '基础用法', exact: true });
        await basicInput.fill('可访问名称回归');
        await expect(basicInput).toHaveValue('可访问名称回归');

        const keyboardInput = page.getByRole('textbox', { name: '键盘处理', exact: true });
        await keyboardInput.fill('按键清空回归');
        await keyboardInput.press('Escape');
        await expect(keyboardInput).toHaveValue('');
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);

        await page.goto(authenticatedRoute('/dev/input-styles'));
        await expect(page.getByTestId('dev-input-styles-screen')).toHaveCSS(
            'background-color',
            'rgb(10, 10, 11)',
        );
        await expect(page.getByTestId('dev-input-styles-heading')).toHaveCSS(
            'color',
            'rgb(229, 229, 231)',
        );
        await expect(page.getByTestId('dev-input-styles-description')).toHaveCSS(
            'color',
            'rgb(107, 107, 118)',
        );

        const styleCards = page.locator('[data-testid^="dev-input-style-"]');
        await expect(styleCards).toHaveCount(22);
        for (let index = 0; index < 22; index += 1) {
            const card = styleCards.nth(index);
            await expect(card).toHaveAttribute('role', 'radio');
            await card.click();
            await expect(card).toHaveAttribute('aria-checked', 'true');
        }

        const nestedFocusableCount = await styleCards.evaluateAll((cards) => (
            cards.reduce(
                (count, card) => count + card.querySelectorAll('[tabindex="0"]').length,
                0,
            )
        ));
        expect(nestedFocusableCount).toBe(0);

        const previewInputs = page
            .getByTestId('dev-input-styles-screen')
            .getByRole('textbox', { includeHidden: true });
        await expect(previewInputs).toHaveCount(23);
        for (let index = 0; index < 23; index += 1) {
            await expect(previewInputs.nth(index)).toHaveAttribute('tabindex', '-1');
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);

        await page.goto(authenticatedRoute('/settings/appearance'));
        await page.getByText('Caramel', { exact: true }).click();
        await page.goto(authenticatedRoute('/dev/input-styles'));
        await expect(page.getByTestId('dev-input-styles-screen')).toHaveCSS(
            'background-color',
            'rgb(26, 21, 18)',
        );
    });
});

test.describe('中文 Web 运行时演示', () => {
    test.use({ locale: 'zh-CN' });

    test('日志操作具备稳定名称且应用内测试汇总跟随深色主题', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/settings/appearance'));
        await page.getByText('Terminal', { exact: true }).click();
        await page.goto(authenticatedRoute('/dev/logs'));

        await expect(page.getByTestId('dev-logs-screen')).toHaveCSS(
            'background-color',
            'rgb(10, 10, 11)',
        );
        await expect(page.getByTestId('dev-logs-surface')).toHaveCSS(
            'background-color',
            'rgb(19, 19, 22)',
        );
        await expect(page.getByRole('button', { name: '添加测试日志', exact: true })).toHaveCount(1);
        await expect(page.getByRole('button', { name: '复制全部日志', exact: true })).toHaveCount(1);
        const clearLogs = page.getByRole('button', { name: '清除全部日志', exact: true });
        await expect(clearLogs).toHaveCount(1);

        await page.getByRole('button', { name: '添加测试日志', exact: true }).click();
        await clearLogs.click();
        const clearDialog = page.getByRole('dialog', { name: '清除日志', exact: true });
        await expect(clearDialog).toBeVisible();
        await clearDialog.getByRole('button', { name: '取消', exact: true }).click();
        await expect(clearDialog).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);

        await page.goto(authenticatedRoute('/dev/tests'));
        await page.getByRole('button', { name: /运行全部测试/ }).click();
        const summary = page.getByTestId('dev-tests-summary');
        await expect(summary).toBeVisible();
        await expect(summary).toHaveCSS('background-color', 'rgb(19, 19, 22)');
        const totalTests = Number(await page.getByTestId('dev-tests-total').textContent());
        const passedTests = Number(await page.getByTestId('dev-tests-passed').textContent());
        const failedTests = Number(await page.getByTestId('dev-tests-failed').textContent());
        expect(totalTests).toBeGreaterThan(0);
        expect(passedTests).toBe(totalTests);
        expect(failedTests).toBe(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);
    });

    test('Unistyles 主题选择保留主题包并暴露实时状态', async ({ page }) => {
        const deprecatedShadowWarnings: string[] = [];
        page.on('console', (message) => {
            if (
                message.type() === 'warning'
                && message.text().includes('"shadow*" style props are deprecated')
            ) {
                deprecatedShadowWarnings.push(message.text());
            }
        });
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/settings/appearance'));
        await page.getByText('Terminal', { exact: true }).click();
        await page.goto(authenticatedRoute('/dev/unistyles-demo'));

        await expect(page.getByTestId('dev-unistyles-screen')).toHaveCSS(
            'background-color',
            'rgb(10, 10, 11)',
        );
        await expect(page.getByTestId('dev-unistyles-theme-heading')).toHaveCSS(
            'color',
            'rgb(229, 229, 231)',
        );
        const themeGroup = page.getByRole('radiogroup', { name: '主题系统', exact: true });
        const lightTheme = themeGroup.getByRole('radio', { name: '浅色', exact: true });
        const darkTheme = themeGroup.getByRole('radio', { name: '深色', exact: true });
        await expect(lightTheme).toHaveAttribute('aria-checked', 'false');
        await expect(darkTheme).toHaveAttribute('aria-checked', 'true');

        await lightTheme.click();
        await expect(page.getByText('当前主题：terminalLight', { exact: true })).toBeVisible();
        await expect(lightTheme).toHaveAttribute('aria-checked', 'true');
        await darkTheme.click();
        await expect(page.getByText('当前主题：terminalDark', { exact: true })).toBeVisible();
        await expect(darkTheme).toHaveAttribute('aria-checked', 'true');

        const runtimeSwitch = page.getByRole('switch', { name: '显示运行时详情', exact: true });
        await expect(runtimeSwitch).toBeChecked();
        await runtimeSwitch.click();
        await expect(runtimeSwitch).not.toBeChecked();
        await runtimeSwitch.click();
        await expect(runtimeSwitch).toBeChecked();

        await expect(page.getByTestId('dev-unistyles-color-scheme')).toHaveCount(0);
        await expect(page.getByTestId('dev-unistyles-breakpoint-description')).toContainText('800');
        await expect(page.getByTestId('dev-unistyles-breakpoint-description')).not.toContainText('1440');
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);
        expect(deprecatedShadowWarnings).toEqual([]);

        await page.goto(authenticatedRoute('/settings/appearance'));
        await page.getByText('Caramel', { exact: true }).click();
    });
});

test.describe('中文 Web 二维码与会话编辑器演示', () => {
    test.use({ locale: 'zh-CN' });

    test('二维码空输入保持页面稳定且所有图形都有持久名称', async ({ page }) => {
        let warningCount = 0;
        let errorCount = 0;
        let failedRequestCount = 0;
        const consoleErrorKinds: string[] = [];
        const failedRequestTypes: string[] = [];
        const failedRequestReasons: string[] = [];
        page.on('console', (message) => {
            if (message.type() === 'warning') warningCount += 1;
            if (message.type() === 'error') {
                errorCount += 1;
                consoleErrorKinds.push(
                    message.text().includes('Failed to load resource')
                        ? 'resource-load'
                        : 'other',
                );
            }
        });
        page.on('requestfailed', (request) => {
            if (['fetch', 'xhr'].includes(request.resourceType())) {
                failedRequestCount += 1;
                failedRequestTypes.push(request.resourceType());
                const reason = request.failure()?.errorText;
                failedRequestReasons.push(
                    reason?.startsWith('net::')
                        ? reason.split(' ')[0]
                        : 'other',
                );
            }
        });

        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/dev/qr-test'));

        const screen = page.getByTestId('dev-qr-screen');
        const input = page.getByTestId('dev-qr-custom-input');
        await expect(screen).toBeVisible();
        await expect(input).toHaveAccessibleName(/.+/);
        await expect(screen.getByRole('img')).toHaveCount(17);
        await page.waitForTimeout(300);
        const loadEvidence = {
            warningCount,
            errorCount,
            failedRequestCount,
            consoleErrorKinds: [...consoleErrorKinds].sort(),
            failedRequestTypes: [...failedRequestTypes].sort(),
            failedRequestReasons: [...failedRequestReasons].sort(),
        };
        expect(loadEvidence).toEqual(expectedIsolatedDevRouteLoadEvidence);
        const actionBaseline = { warningCount, errorCount, failedRequestCount };

        await input.fill('');

        await expect(screen).toBeVisible();
        await expect(screen.getByRole('img')).toHaveCount(16);
        await expect(page).toHaveURL(authenticatedRoute('/dev/qr-test'));
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);
        expect({
            warningCount: warningCount - actionBaseline.warningCount,
            errorCount: errorCount - actionBaseline.errorCount,
            failedRequestCount: failedRequestCount - actionBaseline.failedRequestCount,
        }).toEqual({
            warningCount: 0,
            errorCount: 0,
            failedRequestCount: 0,
        });
    });

    test('会话编辑器配置与选择器暴露完整语义且没有空操作焦点', async ({ page }) => {
        let warningCount = 0;
        let errorCount = 0;
        let failedRequestCount = 0;
        const consoleErrorKinds: string[] = [];
        const failedRequestTypes: string[] = [];
        const failedRequestReasons: string[] = [];
        page.on('console', (message) => {
            if (message.type() === 'warning') warningCount += 1;
            if (message.type() === 'error') {
                errorCount += 1;
                consoleErrorKinds.push(
                    message.text().includes('Failed to load resource')
                        ? 'resource-load'
                        : 'other',
                );
            }
        });
        page.on('requestfailed', (request) => {
            if (['fetch', 'xhr'].includes(request.resourceType())) {
                failedRequestCount += 1;
                failedRequestTypes.push(request.resourceType());
                const reason = request.failure()?.errorText;
                failedRequestReasons.push(
                    reason?.startsWith('net::')
                        ? reason.split(' ')[0]
                        : 'other',
                );
            }
        });

        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/dev/session-composer'));

        const screen = page.getByTestId('dev-composer-screen');
        await expect(screen).toBeVisible();
        for (const testID of [
            'dev-composer-machine',
            'dev-composer-path',
            'dev-composer-agent',
            'dev-composer-model',
            'dev-composer-effort',
            'dev-composer-permission',
            'dev-composer-worktree',
        ]) {
            const trigger = page.getByTestId(testID);
            await expect(trigger).toHaveAttribute('role', 'button');
            await expect(trigger).toHaveAccessibleName(/.+/);
        }
        await page.waitForTimeout(300);
        const loadEvidence = {
            warningCount,
            errorCount,
            failedRequestCount,
            consoleErrorKinds: [...consoleErrorKinds].sort(),
            failedRequestTypes: [...failedRequestTypes].sort(),
            failedRequestReasons: [...failedRequestReasons].sort(),
        };
        expect(loadEvidence).toEqual(expectedIsolatedDevRouteLoadEvidence);
        const actionBaseline = { warningCount, errorCount, failedRequestCount };

        const machine = page.getByTestId('dev-composer-machine');
        await expect(machine).toHaveAttribute('aria-expanded', 'false');
        await machine.click();
        await expect(machine).toHaveAttribute('aria-expanded', 'true');

        const picker = page.getByTestId('dev-composer-picker');
        await expect(picker).toHaveAttribute('role', 'dialog');
        await expect(picker).toHaveAccessibleName(/.+/);
        await expect(picker.getByRole('radiogroup')).toHaveCount(1);
        await expect(picker.getByRole('radio')).toHaveCount(3);
        await expect(picker.getByRole('radio', { checked: true })).toHaveCount(1);
        await expect(picker.getByRole('textbox')).toHaveAccessibleName(/.+/);
        await picker.getByRole('radio').nth(1).click();
        await expect(picker).toHaveCount(0);

        const input = page.getByTestId('dev-composer-input');
        await expect(input).toHaveAccessibleName(/.+/);
        await input.fill('本地演示');
        const collapsedConfig = page.getByTestId('dev-composer-config-toggle');
        await expect(collapsedConfig).toHaveAttribute('role', 'button');
        await expect(collapsedConfig).toHaveAttribute('aria-expanded', 'false');
        const sendVisual = page.getByTestId('dev-composer-send-visual');
        await expect(sendVisual).not.toHaveAttribute('role', /.+/);
        await expect(sendVisual).not.toHaveAttribute('tabindex', /.+/);
        await expect(sendVisual).not.toHaveAttribute('aria-label', /.+/);
        await expect(sendVisual.locator('[role="button"], [tabindex="0"]')).toHaveCount(0);
        await expect(screen.locator('[tabindex="0"]:not([role]):not([aria-label])')).toHaveCount(0);
        await input.fill('');

        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);
        expect({
            warningCount: warningCount - actionBaseline.warningCount,
            errorCount: errorCount - actionBaseline.errorCount,
            failedRequestCount: failedRequestCount - actionBaseline.failedRequestCount,
        }).toEqual({
            warningCount: 0,
            errorCount: 0,
            failedRequestCount: 0,
        });
    });
});
