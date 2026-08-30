import { expect, test, type APIRequestContext, type Page, type Route, type TestInfo } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { encodeBase64, encryptLegacy } from '../../happy-cli/src/api/encryption';

const authenticatedWebUrl = process.env.HAPPY_E2E_WEB_URL!;
const e2eServerUrl = process.env.HAPPY_E2E_SERVER_URL!;
const videoFixturePath = process.env.HAPPY_E2E_MP4_PATH!;
const evidenceDirectory = process.env.HAPPY_PUBLIC_SHARE_EVIDENCE_DIR;
const evidencePhase = process.env.HAPPY_PUBLIC_SHARE_EVIDENCE_PHASE ?? 'after';

type Credentials = { encryptionKey: Uint8Array; token: string };

function credentials(): Credentials {
    const authUrl = new URL(authenticatedWebUrl);
    const token = authUrl.searchParams.get('dev_token');
    const secret = authUrl.searchParams.get('dev_secret');
    if (!token || !secret) throw new Error('Missing local E2E authentication.');
    return { token, encryptionKey: new Uint8Array(Buffer.from(secret, 'base64url')) };
}

function authenticatedRoute(pathname: string): string {
    const url = new URL(authenticatedWebUrl);
    url.pathname = pathname;
    return url.toString();
}

function evidencePath(testInfo: TestInfo, name: string): string {
    const filename = `${name}-${evidencePhase}.png`;
    return evidenceDirectory ? `${evidenceDirectory}/${filename}` : testInfo.outputPath(filename);
}

async function createSession(request: APIRequestContext): Promise<string> {
    const auth = credentials();
    const title = '[PUBLIC-SESSION-SHARE] 产品发布检查清单';
    const metadata = encodeBase64(encryptLegacy({
        path: '/workspace/public-session-share-e2e',
        host: 'playwright-public-share.local',
        name: 'Public session sharing fixture',
        summary: { text: title, updatedAt: Date.now() },
        flavor: 'codex',
        lifecycleState: 'running',
        startedBy: 'terminal',
        models: [{ code: 'gpt-5.6-sol', value: 'gpt-5.6-sol' }],
        currentModelCode: 'gpt-5.6-sol',
        thoughtLevels: [{ code: 'xhigh', value: 'xhigh' }],
        currentThoughtLevelCode: 'xhigh',
    }, auth.encryptionKey));
    const response = await request.post(new URL('/v1/sessions', e2eServerUrl).toString(), {
        data: {
            tag: `public-session-share-${Date.now()}-${Math.random()}`,
            metadata,
            agentState: null,
            dataEncryptionKey: null,
        },
        headers: {
            Authorization: `Bearer ${auth.token}`,
            'X-Happy-Client': 'playwright-public-session-share',
        },
    });
    expect(response.ok()).toBe(true);
    return (await response.json() as { session: { id: string } }).session.id;
}

async function appendConversation(request: APIRequestContext, sessionId: string): Promise<void> {
    const auth = credentials();
    const video = readFileSync(videoFixturePath);
    const uploadRequest = await request.post(
        new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/attachments/request-upload`, e2eServerUrl).toString(),
        {
            data: { filename: '发布演示.mp4', size: video.length, kind: 'video' },
            headers: {
                Authorization: `Bearer ${auth.token}`,
                'X-Happy-Client': 'playwright-public-session-share',
            },
        },
    );
    expect(uploadRequest.ok()).toBe(true);
    const upload = await uploadRequest.json() as { ref: string; uploadUrl: string; method: 'PUT' };
    expect(upload.method).toBe('PUT');
    const uploadUrl = new URL(upload.uploadUrl);
    uploadUrl.hostname = new URL(e2eServerUrl).hostname;
    uploadUrl.port = new URL(e2eServerUrl).port;
    const uploaded = await request.put(uploadUrl.toString(), {
        data: video,
        headers: {
            Authorization: `Bearer ${auth.token}`,
            'Content-Type': 'application/octet-stream',
            'X-Happy-Client': 'playwright-public-session-share',
        },
    });
    expect(uploaded.ok()).toBe(true);

    const now = Date.now();
    const envelopes = [
        {
            role: 'user',
            content: { type: 'text', text: '请确认公开分享页只展示对话正文和全部附件。' },
            meta: { sentFrom: 'playwright-public-session-share' },
        },
        {
            role: 'agent',
            content: {
                type: 'acp',
                provider: 'codex',
                data: {
                    type: 'tool-call',
                    callId: `public-share-read-${now}`,
                    id: `public-share-read-${now}`,
                    input: { file_path: '/workspace/public-session-share-e2e/release-checklist.md' },
                    name: 'Read',
                },
            },
            meta: { sentFrom: 'cli' },
        },
        {
            role: 'agent',
            content: {
                type: 'acp',
                provider: 'codex',
                data: {
                    type: 'tool-result',
                    callId: `public-share-read-${now}`,
                    id: `public-share-read-result-${now}`,
                    output: { success: true },
                },
            },
            meta: { sentFrom: 'cli' },
        },
        {
            role: 'agent',
            content: {
                type: 'acp',
                provider: 'codex',
                data: {
                    type: 'tool-call',
                    callId: `public-share-test-${now}`,
                    id: `public-share-test-${now}`,
                    input: { command: 'pnpm test -- --grep public-session-share' },
                    name: 'Bash',
                },
            },
            meta: { sentFrom: 'cli' },
        },
        {
            role: 'agent',
            content: {
                type: 'acp',
                provider: 'codex',
                data: {
                    type: 'tool-result',
                    callId: `public-share-test-${now}`,
                    id: `public-share-test-result-${now}`,
                    output: { success: true },
                },
            },
            meta: { sentFrom: 'cli' },
        },
        {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    message: {
                        role: 'assistant',
                        model: 'gpt-5.6-sol',
                        content: [{ type: 'text', text: '已检查：这是一次不可继续输入、可随时撤销的公开快照。' }],
                    },
                    uuid: `public-share-assistant-${now}`,
                },
            },
            meta: { sentFrom: 'cli' },
        },
        {
            role: 'session',
            content: {
                type: 'session',
                data: {
                    id: `public-share-video-${now}`,
                    time: now,
                    role: 'agent',
                    turn: `public-share-turn-${now}`,
                    ev: {
                        t: 'file',
                        ref: upload.ref,
                        name: '发布演示.mp4',
                        size: video.length,
                        kind: 'video',
                        mimeType: 'video/mp4',
                        encrypted: false,
                        source: 'generated',
                    },
                },
            },
        },
    ];
    const response = await request.post(
        new URL(`/v3/sessions/${encodeURIComponent(sessionId)}/messages`, e2eServerUrl).toString(),
        {
            data: {
                messages: envelopes.map((envelope, index) => ({
                    content: encodeBase64(encryptLegacy(envelope, auth.encryptionKey)),
                    localId: `public-session-share-${index}-${now}`,
                })),
            },
            headers: {
                Authorization: `Bearer ${auth.token}`,
                'X-Happy-Client': 'playwright-public-session-share',
            },
        },
    );
    expect(response.ok()).toBe(true);
}

async function proxyPublicRequests(route: Route): Promise<void> {
    const incoming = new URL(route.request().url());
    const upstream = new URL(`${incoming.pathname}${incoming.search}`, e2eServerUrl);
    const headers = await route.request().allHeaders();
    delete headers.authorization;
    delete headers.cookie;
    const response = await route.fetch({ url: upstream.toString(), headers });
    await route.fulfill({ response });
}

async function openShareDialog(page: Page): Promise<void> {
    await page.locator('[data-testid="session-header-more-button"]:visible').click();
    await expect(page.getByTestId('session-agent-panel')).toBeVisible();
    await page.getByTestId('session-agent-panel-share-session').click();
    await expect(page.getByTestId('public-session-share-dialog')).toBeVisible();
    await expect(page.getByTestId('public-session-share-checking')).toHaveCount(0);
}

async function enableToolGrouping(page: Page): Promise<void> {
    await page.goto(authenticatedRoute('/settings/features'), { waitUntil: 'domcontentloaded', timeout: 180_000 });
    const toggle = page.getByRole('switch', { name: 'Group Tool Calls' });
    await expect(toggle).toBeVisible({ timeout: 180_000 });
    if (!await toggle.isChecked()) {
        const saved = page.waitForResponse((response) => (
            response.request().method() === 'POST'
            && new URL(response.url()).pathname === '/v1/account/settings'
        ));
        await toggle.click();
        expect((await saved).ok()).toBe(true);
    }
    await expect(toggle).toBeChecked();
}

async function messageStyleSignature(page: Page, testIdPrefix: 'message-user-' | 'message-agent-', text: string) {
    const message = page.locator(`[data-testid^="${testIdPrefix}"]`).filter({ hasText: text }).first();
    await expect(message).toBeVisible();
    return message.evaluate((element) => {
        const target = element.firstElementChild instanceof HTMLElement ? element.firstElementChild : element;
        const style = getComputedStyle(target);
        return {
            alignItems: style.alignItems,
            backgroundColor: style.backgroundColor,
            borderRadius: style.borderRadius,
            display: style.display,
            flexDirection: style.flexDirection,
            maxWidth: style.maxWidth,
            paddingBottom: style.paddingBottom,
            paddingLeft: style.paddingLeft,
            paddingRight: style.paddingRight,
            paddingTop: style.paddingTop,
        };
    });
}

async function elementStyleSignature(page: Page, testID: string) {
    const element = page.getByTestId(testID).first();
    await expect(element).toBeVisible();
    return element.evaluate((node) => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return {
            backgroundColor: style.backgroundColor,
            borderBottomLeftRadius: style.borderBottomLeftRadius,
            borderBottomRightRadius: style.borderBottomRightRadius,
            borderTopLeftRadius: style.borderTopLeftRadius,
            borderTopRightRadius: style.borderTopRightRadius,
            display: style.display,
            height: Math.round(rect.height),
            maxWidth: style.maxWidth,
            paddingBottom: style.paddingBottom,
            paddingLeft: style.paddingLeft,
            paddingRight: style.paddingRight,
            paddingTop: style.paddingTop,
            width: Math.round(rect.width),
        };
    });
}

test.afterEach(async ({ page }) => {
    await page.close();
});

test('PUBLIC-SESSION-SHARE owner publishes a complete snapshot and anonymous viewers stay read-only', async ({ page, request }, testInfo) => {
    test.setTimeout(600_000);
    const sessionId = await createSession(request);
    await appendConversation(request, sessionId);
    await page.setViewportSize({ width: 1440, height: 900 });
    await enableToolGrouping(page);
    await page.goto(authenticatedRoute(`/session/${sessionId}`), { waitUntil: 'domcontentloaded', timeout: 180_000 });
    await expect(page.getByTestId('session-message-input')).toBeVisible({ timeout: 180_000 });
    await expect(page.getByTestId('conversation-transcript-list')).toBeVisible();
    await expect(page.getByTestId('media-attachment-player-generated')).toBeVisible();
    const authenticatedUserStyle = await messageStyleSignature(
        page,
        'message-user-',
        '请确认公开分享页只展示对话正文和全部附件。',
    );
    const authenticatedAgentStyle = await messageStyleSignature(
        page,
        'message-agent-',
        '已检查：这是一次不可继续输入、可随时撤销的公开快照。',
    );
    const authenticatedVideoStyle = await elementStyleSignature(page, 'media-attachment-player-generated');
    const authenticatedWorkToggle = page.getByTestId('conversation-agent-work-toggle').first();
    await expect(authenticatedWorkToggle).toBeVisible();
    await expect(page.getByTestId('conversation-tool-group-toggle')).toHaveCount(0);
    const authenticatedWorkStyle = await elementStyleSignature(page, 'conversation-agent-work-toggle');
    const authenticatedWorkLabel = (await authenticatedWorkToggle.textContent())?.trim();
    await authenticatedWorkToggle.click();
    await expect(page.getByTestId('conversation-tool-group-toggle').first()).toBeVisible();
    await authenticatedWorkToggle.click();
    await expect(page.getByTestId('conversation-tool-group-toggle')).toHaveCount(0);
    await page.screenshot({ path: evidencePath(testInfo, 'authenticated-conversation'), fullPage: true });

    await openShareDialog(page);
    await expect(page.getByTestId('public-session-share-privacy-message')).toContainText('all attachments');
    await page.getByTestId('public-session-share-create').click();
    await expect(page.getByTestId('public-session-share-copy')).toBeVisible({ timeout: 60_000 });
    const publicUrl = (await page.getByText(/\/share\//).first().textContent())?.trim();
    expect(publicUrl).toMatch(/^http:\/\/localhost:\d+\/share\/[A-Za-z0-9_-]+$/);
    const publicId = new URL(publicUrl!).pathname.split('/').pop()!;
    await page.screenshot({ path: evidencePath(testInfo, 'owner-manage-share'), fullPage: true });

    await page.route('**/v1/public/session-shares/**', proxyPublicRequests);
    const publicApiResponse = await request.get(
        new URL(`/v1/public/session-shares/${encodeURIComponent(publicId)}`, e2eServerUrl).toString(),
    );
    expect(publicApiResponse.ok()).toBe(true);
    const publicPayload = await publicApiResponse.json() as {
        snapshot: { messages: Array<{ blocks: Array<{ type: string; attachmentId?: string; name?: string }> }> };
    };
    const attachment = publicPayload.snapshot.messages
        .flatMap((message) => message.blocks)
        .find((block) => block.type === 'attachment');
    expect(attachment).toMatchObject({ type: 'attachment', name: '发布演示.mp4' });
    const attachmentResponse = await request.get(
        new URL(`/v1/public/session-shares/${encodeURIComponent(publicId)}/attachments/${encodeURIComponent(attachment!.attachmentId!)}`, e2eServerUrl).toString(),
    );
    expect(attachmentResponse.ok()).toBe(true);
    expect((await attachmentResponse.body()).length).toBeGreaterThan(0);

    await page.goto(publicUrl!, { waitUntil: 'domcontentloaded', timeout: 180_000 });
    await expect(page.getByTestId('public-session-transcript')).toBeVisible({ timeout: 180_000 });
    await expect(page.getByTestId('conversation-transcript-list')).toBeVisible();
    await expect(page.getByText('[PUBLIC-SESSION-SHARE] 产品发布检查清单', { exact: true })).toBeVisible();
    await expect(page.getByText('请确认公开分享页只展示对话正文和全部附件。', { exact: true })).toBeVisible();
    await expect(page.getByText('已检查：这是一次不可继续输入、可随时撤销的公开快照。', { exact: true })).toBeVisible();
    await expect(page.locator('video')).toBeVisible();
    expect(await messageStyleSignature(
        page,
        'message-user-',
        '请确认公开分享页只展示对话正文和全部附件。',
    )).toEqual(authenticatedUserStyle);
    expect(await messageStyleSignature(
        page,
        'message-agent-',
        '已检查：这是一次不可继续输入、可随时撤销的公开快照。',
    )).toEqual(authenticatedAgentStyle);
    expect(await elementStyleSignature(page, 'media-attachment-player-generated')).toEqual(authenticatedVideoStyle);
    const publicWorkToggle = page.getByTestId('conversation-agent-work-toggle').first();
    await expect(publicWorkToggle).toBeVisible();
    await expect(page.getByTestId('conversation-tool-group-toggle')).toHaveCount(0);
    expect((await publicWorkToggle.textContent())?.trim()).toBe(authenticatedWorkLabel);
    expect(await elementStyleSignature(page, 'conversation-agent-work-toggle')).toEqual(authenticatedWorkStyle);
    await publicWorkToggle.click();
    await expect(page.getByTestId('conversation-tool-group-toggle').first()).toBeVisible();
    await publicWorkToggle.click();
    await expect(page.getByTestId('conversation-tool-group-toggle')).toHaveCount(0);
    await expect(page.getByTestId('public-session-compact-header')).toBeVisible();
    await expect(page.getByRole('heading', { name: '[PUBLIC-SESSION-SHARE] 产品发布检查清单' })).toHaveCSS('font-size', '15px');
    await expect(page.getByTestId('session-message-input')).toHaveCount(0);
    await expect(page.getByTestId('desktop-navigation-sidebar')).toHaveCount(0);
    await expect(page.getByTestId('desktop-right-panel')).toHaveCount(0);
    await expect(page.getByTestId('session-header-more-button')).toHaveCount(0);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex,nofollow,noarchive');
    await page.screenshot({ path: evidencePath(testInfo, 'anonymous-read-only-share'), fullPage: true });

    await page.goto(authenticatedRoute(`/session/${sessionId}`), { waitUntil: 'domcontentloaded', timeout: 180_000 });
    await expect(page.getByTestId('session-message-input')).toBeVisible({ timeout: 180_000 });
    await openShareDialog(page);
    const revokeResponsePromise = page.waitForResponse((response) => (
        response.request().method() === 'DELETE'
        && response.url().endsWith(`/v1/sessions/${sessionId}/share`)
    ));
    await page.getByTestId('public-session-share-revoke').click();
    await expect(page.getByTestId('public-session-share-revoke-confirmation')).toBeVisible();
    await page.getByTestId('public-session-share-revoke-confirm').click();
    expect((await revokeResponsePromise).status()).toBe(200);
    await expect(page.getByTestId('public-session-share-create')).toBeVisible({ timeout: 30_000 });

    const revokedResponse = await request.get(
        new URL(`/v1/public/session-shares/${encodeURIComponent(publicId)}`, e2eServerUrl).toString(),
    );
    expect(revokedResponse.status()).toBe(404);
    await page.goto(publicUrl!, { waitUntil: 'domcontentloaded', timeout: 180_000 });
    await expect(page.getByTestId('public-session-share-unavailable')).toBeVisible({ timeout: 180_000 });
    await expect(page.getByText('This shared session is unavailable', { exact: true })).toBeVisible();
});
