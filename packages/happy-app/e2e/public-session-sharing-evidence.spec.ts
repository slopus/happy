import {
    expect,
    test,
    type APIRequestContext,
    type ConsoleMessage,
    type Locator,
    type Page,
    type Request,
    type Response,
    type Route,
    type TestInfo,
} from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { PublicSessionSnapshot } from '@slopus/happy-wire';
import { encodeBase64, encryptLegacy } from '../../happy-cli/src/api/encryption';
import {
    browserResponseConsoleKey,
    isAllowedLifecycleAbort,
    matchesExpectedBrowserResponse,
    type BrowserRequestFailure,
    type BrowserResponseSummary,
    type ExpectedBrowserResponse,
} from './public-session-sharing-diagnostics';

const authenticatedWebUrl = process.env.HAPPY_E2E_WEB_URL!;
const e2eServerUrl = process.env.HAPPY_E2E_SERVER_URL!;
const authenticatedWebOrigin = new URL(authenticatedWebUrl).origin;
const e2eServerOrigin = new URL(e2eServerUrl).origin;
const videoFixturePath = process.env.HAPPY_E2E_MP4_PATH!;
const evidenceDirectory = process.env.HAPPY_PUBLIC_SHARE_EVIDENCE_DIR;
const coverFixturePath = resolve(process.cwd(), '..', '..', 'docs/assets/plugin-host-v2/marketplace-installed.png');
const appearanceStorageKey = 'paws.public-share.appearance-mode';
const themePackIds = ['caramel', 'gingham', 'terminal', 'acorn', 'sage', 'sakura', 'grape'] as const;

type Credentials = { encryptionKey: Uint8Array; token: string };
type PublishedFixture = { publicId: string; publicUrl: string; sessionId: string };
type ShareCleanupTarget = { label: string; sessionId: string };
type SnapshotV2 = Extract<PublicSessionSnapshot, { version: 2 }>;

function credentials(): Credentials {
    const authUrl = new URL(authenticatedWebUrl);
    const token = authUrl.searchParams.get('dev_token');
    const secret = authUrl.searchParams.get('dev_secret');
    if (!token || !secret) throw new Error('Missing local E2E authentication.');
    return { token, encryptionKey: new Uint8Array(Buffer.from(secret, 'base64url')) };
}

function ownerHeaders(json = false): Record<string, string> {
    return {
        Authorization: `Bearer ${credentials().token}`,
        'X-Happy-Client': 'playwright-public-session-share',
        ...(json ? { 'Content-Type': 'application/json' } : {}),
    };
}

function authenticatedRoute(pathname: string): string {
    const url = new URL(authenticatedWebUrl);
    url.pathname = pathname;
    return url.toString();
}

function publicRoute(publicId: string): string {
    const url = new URL(authenticatedWebUrl);
    url.pathname = `/share/${encodeURIComponent(publicId)}`;
    url.search = '';
    url.hash = '';
    return url.toString();
}

function evidencePath(testInfo: TestInfo, filename: string): string {
    const path = evidenceDirectory ? resolve(evidenceDirectory, filename) : testInfo.outputPath(filename);
    mkdirSync(dirname(path), { recursive: true });
    return path;
}

function currentEvidencePath(testInfo: TestInfo, filename: string): string {
    return evidencePath(testInfo, `raw/current/${filename}`);
}

function createBrowserDiagnostics({
    allowedAbortUrlPrefixes = () => [],
    expectedResponses = () => [],
}: {
    allowedAbortUrlPrefixes?: () => readonly string[];
    expectedResponses?: () => readonly ExpectedBrowserResponse[];
} = {}) {
    const consoleErrors: Array<{ locationUrl: string; text: string }> = [];
    const pageErrors: string[] = [];
    const failedRequests: BrowserRequestFailure[] = [];
    const unexpectedResponses: string[] = [];
    const expectedResponseCounts = new Map<string, number>();
    const observedExpectedConsoleKeys = new Set<string>();
    const monitoredPages = new WeakSet<Page>();

    const responseSummary = (response: Response): BrowserResponseSummary => {
        const url = new URL(response.url());
        return {
            method: response.request().method(),
            origin: url.origin,
            pathname: url.pathname,
            status: response.status(),
        };
    };

    const monitorPage = async (page: Page) => {
        if (monitoredPages.has(page)) return;
        monitoredPages.add(page);
        await page.route(/\/favicon\.ico(?:\?|$)/, (route) => route.fulfill({ status: 204 }));
        await page.addInitScript(() => {
            const browserFetch = window.fetch.bind(window);
            window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
                const requestUrl = new URL(
                    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
                    window.location.href,
                );
                if (requestUrl.href === 'http://localhost:8787/logs') {
                    return Promise.resolve(new Response(null, { status: 204 }));
                }
                return browserFetch(input, init);
            }) as typeof window.fetch;
        });
        page.on('console', (message: ConsoleMessage) => {
            if (message.type() !== 'error') return;
            const locationUrl = message.location().url;
            consoleErrors.push({ text: message.text(), locationUrl });
        });
        page.on('pageerror', (error) => pageErrors.push(error.message));
        page.on('requestfailed', (request: Request) => {
            const error = request.failure()?.errorText ?? 'unknown failure';
            failedRequests.push({
                description: `${request.method()} ${request.url()} — ${error}`,
                error,
                resourceType: request.resourceType(),
                url: request.url(),
            });
        });
        page.on('response', (response: Response) => {
            if (response.status() < 400) return;
            const actual = responseSummary(response);
            const expected = expectedResponses().find((candidate) => (
                matchesExpectedBrowserResponse(actual, candidate)
            ));
            if (expected) {
                const count = (expectedResponseCounts.get(expected.label) ?? 0) + 1;
                expectedResponseCounts.set(expected.label, count);
                observedExpectedConsoleKeys.add(browserResponseConsoleKey(actual));
                if (count <= expected.expectedCount) return;
            }
            unexpectedResponses.push(`${response.status()} ${response.request().method()} ${response.url()}`);
        });
    };

    const expectClean = () => {
        const unexpectedConsoleErrors = consoleErrors.filter((entry) => {
            const status = /Failed to load resource: the server responded with a status of (404|503)/
                .exec(entry.text)?.[1];
            if (!status || !entry.locationUrl) return true;
            const url = new URL(entry.locationUrl);
            return !observedExpectedConsoleKeys.has(browserResponseConsoleKey({
                method: 'GET',
                origin: url.origin,
                pathname: url.pathname,
                status: Number(status),
            }));
        }).map((entry) => `${entry.text} @ ${entry.locationUrl || 'unknown'}`);
        expect(unexpectedConsoleErrors, 'unexpected browser console.error messages').toEqual([]);
        expect(pageErrors, 'uncaught browser page errors').toEqual([]);
        const unexpectedFailedRequests = failedRequests.filter((entry) => (
            !isAllowedLifecycleAbort(entry, allowedAbortUrlPrefixes())
        )).map((entry) => entry.description);
        expect(unexpectedFailedRequests, 'failed browser requests (XHR/fetch, or non-lifecycle aborts)').toEqual([]);
        expect(unexpectedResponses, 'unexpected HTTP >=400 browser responses').toEqual([]);
        for (const expected of expectedResponses()) {
            expect(
                expectedResponseCounts.get(expected.label) ?? 0,
                `${expected.label} response count`,
            ).toBe(expected.expectedCount);
        }
    };

    return { expectClean, monitorPage };
}

async function waitForNextWallClockMillisecond(after: number): Promise<void> {
    const deadline = after + 1_000;
    while (Date.now() <= after) {
        if (Date.now() >= deadline) {
            throw new Error('Timed out waiting for the next wall-clock millisecond while seeding the public-share fixture.');
        }
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, 0));
    }
}

async function createSession(request: APIRequestContext, title = '[PUBLIC-SESSION-SHARE] 产品发布检查清单'): Promise<string> {
    const auth = credentials();
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
        headers: ownerHeaders(),
    });
    expect(response.ok()).toBe(true);
    return (await response.json() as { session: { id: string } }).session.id;
}

async function appendConversation(request: APIRequestContext, sessionId: string): Promise<void> {
    const auth = credentials();
    const video = readFileSync(videoFixturePath);
    const uploadRequest = await request.post(
        new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/attachments/request-upload`, e2eServerUrl).toString(),
        { data: { filename: '发布演示.mp4', size: video.length, kind: 'video' }, headers: ownerHeaders() },
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
                type: 'acp', provider: 'codex',
                data: {
                    type: 'tool-call', callId: `public-share-read-${now}`, id: `public-share-read-${now}`,
                    input: { file_path: '/workspace/public-session-share-e2e/release-checklist.md' }, name: 'Read',
                },
            },
            meta: { sentFrom: 'cli' },
        },
        {
            role: 'agent',
            content: {
                type: 'acp', provider: 'codex',
                data: {
                    type: 'tool-result', callId: `public-share-read-${now}`, id: `public-share-read-result-${now}`,
                    output: { success: true },
                },
            },
            meta: { sentFrom: 'cli' },
        },
        {
            role: 'agent',
            content: {
                type: 'acp', provider: 'codex',
                data: {
                    type: 'tool-call', callId: `public-share-test-${now}`, id: `public-share-test-${now}`,
                    input: { command: 'pnpm test -- --grep public-session-share' }, name: 'Bash',
                },
            },
            meta: { sentFrom: 'cli' },
        },
        {
            role: 'agent',
            content: {
                type: 'acp', provider: 'codex',
                data: {
                    type: 'tool-result', callId: `public-share-test-${now}`, id: `public-share-test-result-${now}`,
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
                        role: 'assistant', model: 'gpt-5.6-sol',
                        content: [{
                            type: 'text',
                            text: [
                                '已检查：这是一次不可继续输入、可随时撤销的公开快照。',
                                ...Array.from({ length: 36 }, (_, index) => `发布检查项 ${index + 1}：公开页只展示快照内容。`),
                                '```sh\npnpm test -- --grep public-session-share\n```',
                            ].join('\n\n'),
                        }],
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
                    id: `public-share-video-${now}`, time: now, role: 'agent', turn: `public-share-turn-${now}`,
                    ev: {
                        t: 'file', ref: upload.ref, name: '发布演示.mp4', size: video.length,
                        kind: 'video', mimeType: 'video/mp4', encrypted: false, source: 'generated',
                    },
                },
            },
        },
    ];
    for (const [index, envelope] of envelopes.entries()) {
        const response = await request.post(
            new URL(`/v3/sessions/${encodeURIComponent(sessionId)}/messages`, e2eServerUrl).toString(),
            {
                data: {
                    messages: [{
                        content: encodeBase64(encryptLegacy(envelope, auth.encryptionKey)),
                        localId: `public-session-share-${index}-${now}`,
                    }],
                },
                headers: ownerHeaders(),
            },
        );
        expect(response.ok()).toBe(true);
        await waitForNextWallClockMillisecond(Date.now());
    }
}

function longMessages(label: string, lineCount = 72): PublicSessionSnapshot['messages'] {
    return [{
        id: `${label}-assistant`,
        role: 'assistant',
        createdAt: Date.UTC(2026, 8, 3, 4, 0, 0),
        blocks: [{
            type: 'text',
            markdown: [
                `${label}: anonymous public snapshot.`,
                ...Array.from({ length: lineCount }, (_, index) => `${label} verification line ${index + 1}: immutable and read-only.`),
                '```sh\npnpm test -- --grep public-session-share\n```',
            ].join('\n\n'),
        }],
    }];
}

async function publishDirectSnapshot(
    request: APIRequestContext,
    snapshot: PublicSessionSnapshot,
    registerCleanup: (target: ShareCleanupTarget) => void,
): Promise<PublishedFixture> {
    const sessionId = await createSession(request, snapshot.title);
    registerCleanup({ label: snapshot.title, sessionId });
    const draftResponse = await request.post(
        new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/share/drafts`, e2eServerUrl).toString(),
        { headers: ownerHeaders() },
    );
    expect(draftResponse.ok()).toBe(true);
    const draft = await draftResponse.json() as { generation: string; publicId: string };
    const publishResponse = await request.put(
        new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/share/drafts/${encodeURIComponent(draft.generation)}/publish`, e2eServerUrl).toString(),
        { data: { snapshot }, headers: ownerHeaders(true) },
    );
    expect(publishResponse.ok()).toBe(true);
    return { publicId: draft.publicId, publicUrl: publicRoute(draft.publicId), sessionId };
}

async function revokeShare(request: APIRequestContext, sessionId: string): Promise<number> {
    const response = await request.delete(
        new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/share`, e2eServerUrl).toString(),
        { headers: ownerHeaders() },
    );
    const status = response.status();
    if (status !== 200 && status !== 404) {
        throw new Error(`Share cleanup returned HTTP ${status}.`);
    }
    return status;
}

async function cleanupShares(
    request: APIRequestContext,
    targets: readonly ShareCleanupTarget[],
    primaryFailure: unknown,
): Promise<void> {
    const results = await Promise.allSettled(targets.map(async (target) => ({
        label: target.label,
        status: await revokeShare(request, target.sessionId),
    })));
    const failures = results.flatMap((result, index) => (
        result.status === 'rejected'
            ? [`${targets[index]?.label ?? `fixture-${index}`}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
            : []
    ));
    if (failures.length === 0) return;
    const message = `Public-share cleanup failed:\n${failures.join('\n')}`;
    if (primaryFailure) {
        console.warn(message);
        return;
    }
    throw new Error(message);
}

async function proxyAnonymousPublicRequest(route: Route): Promise<void> {
    const incoming = new URL(route.request().url());
    const incomingHeaders = await route.request().allHeaders();
    expect(incomingHeaders.authorization).toBeUndefined();
    expect(incomingHeaders.cookie).toBeUndefined();
    const headers = { ...incomingHeaders };
    delete headers.authorization;
    delete headers.cookie;
    const response = await route.fetch({
        url: new URL(`${incoming.pathname}${incoming.search}`, e2eServerUrl).toString(),
        headers,
    });
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
            response.request().method() === 'POST' && new URL(response.url()).pathname === '/v1/account/settings'
        ));
        await toggle.click();
        expect((await saved).ok()).toBe(true);
    }
    await expect(toggle).toBeChecked();
}

async function enableGinghamDark(page: Page): Promise<void> {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(authenticatedRoute('/settings/appearance'), { waitUntil: 'domcontentloaded', timeout: 180_000 });
    await page.getByText('Gingham', { exact: true }).click();
    await expectBodyColor(page, 'rgb(18, 24, 33)');
}

async function expectBodyColor(page: Page, color: string): Promise<void> {
    await expect.poll(() => page.locator('body').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(color);
}

async function expectPublicPageColor(page: Page, color: string): Promise<void> {
    await expect.poll(() => page.getByTestId('public-session-transcript')
        .evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(color);
}

async function expectSelectedTheme(page: Page, themePack: (typeof themePackIds)[number]): Promise<void> {
    const selected = page.getByRole('radio', { name: `Theme color: ${themePack}`, exact: true });
    const unselected = page.getByRole('radio', {
        name: `Theme color: ${themePackIds.find((candidate) => candidate !== themePack)!}`,
        exact: true,
    });
    await expect.poll(async () => {
        const [selectedText, selectedSurface, unselectedText, unselectedSurface] = await Promise.all([
            selected.textContent(),
            selected.evaluate((element) => getComputedStyle(element).backgroundColor),
            unselected.textContent(),
            unselected.evaluate((element) => getComputedStyle(element).backgroundColor),
        ]);
        return (selectedText?.trim().length ?? 0) > 0
            && (unselectedText?.trim().length ?? 0) === 0
            && selectedSurface !== unselectedSurface;
    }).toBe(true);
    await expect(page.getByRole('radio', { name: `Theme color: ${themePack}`, checked: true, exact: true })).toHaveCount(1);
}

async function expectSelectedMode(page: Page, mode: 'Light' | 'Dark' | 'System'): Promise<void> {
    await expect(page.getByRole('button', { name: mode, exact: true })).toHaveAttribute('aria-pressed', 'true');
}

async function expectModeTooltips(page: Page): Promise<void> {
    const light = page.getByRole('button', { name: 'Light', exact: true });
    const dark = page.getByRole('button', { name: 'Dark', exact: true });
    const title = page.getByTestId('public-session-title');

    await light.hover();
    const lightTooltip = page.getByTestId('public-session-appearance-tooltip-light');
    await expect(lightTooltip).toBeVisible();
    await expect(lightTooltip).toHaveText('Light');
    const [lightTooltipBox, titleBox] = await Promise.all([lightTooltip.boundingBox(), title.boundingBox()]);
    expect(lightTooltipBox).not.toBeNull();
    expect(titleBox).not.toBeNull();
    expect(lightTooltipBox!.x).toBeGreaterThanOrEqual(titleBox!.x + titleBox!.width);
    await page.mouse.move(0, 0);
    await expect(lightTooltip).toHaveCount(0);

    await dark.focus();
    const darkTooltip = page.getByTestId('public-session-appearance-tooltip-dark');
    await expect(darkTooltip).toBeVisible();
    await expect(darkTooltip).toHaveText('Dark');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(darkTooltip).toHaveCount(0);
}

async function expectAnonymousReadOnly(page: Page): Promise<void> {
    await expect(page.getByTestId('public-session-transcript')).toBeVisible({ timeout: 180_000 });
    await expect(page.getByTestId('conversation-transcript-list')).toBeVisible();
    await expect(page.getByTestId('public-session-compact-header')).toBeVisible();
    await expect(page.getByTestId('session-message-input')).toHaveCount(0);
    await expect(page.getByTestId('desktop-navigation-sidebar')).toHaveCount(0);
    await expect(page.getByTestId('desktop-right-panel')).toHaveCount(0);
    await expect(page.getByTestId('session-header-more-button')).toHaveCount(0);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex,nofollow,noarchive');
    expect(await page.context().cookies()).toEqual([]);
    expect(await page.evaluate(() => Object.keys(localStorage).every((key) => !/token|secret|auth/i.test(key)))).toBe(true);
}

async function expectLoadedVectorIcon(icon: Locator): Promise<void> {
    await expect(icon).toBeVisible();
    const signature = await icon.evaluate((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
            fontFamily: style.fontFamily,
            fontLoaded: document.fonts.check(`${style.fontSize} ${style.fontFamily}`),
            height: rect.height,
            text: element.textContent ?? '',
            width: rect.width,
        };
    });
    expect(signature.text.length).toBeGreaterThan(0);
    expect(signature.width).toBeGreaterThan(0);
    expect(signature.height).toBeGreaterThan(0);
    expect(signature.fontLoaded, `font was not loaded: ${signature.fontFamily}`).toBe(true);
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

function expectSameLayout<T extends { backgroundColor: string }>(actual: T, expected: T): void {
    const { backgroundColor: actualBackgroundColor, ...actualLayout } = actual;
    const { backgroundColor: expectedBackgroundColor, ...expectedLayout } = expected;
    expect(actualLayout as Record<string, unknown>).toEqual(expectedLayout as Record<string, unknown>);
    expect(actualBackgroundColor).toMatch(/^rgba?\(/);
    expect(expectedBackgroundColor).toMatch(/^rgba?\(/);
}

function expectSameMediaPresentation(
    actual: Awaited<ReturnType<typeof elementStyleSignature>>,
    expected: Awaited<ReturnType<typeof elementStyleSignature>>,
): void {
    const { width: actualWidth, height: actualHeight, ...actualVisualStyle } = actual;
    const { width: expectedWidth, height: expectedHeight, ...expectedVisualStyle } = expected;
    expect(actualVisualStyle).toEqual(expectedVisualStyle);
    expect(actualWidth).toBeGreaterThan(0);
    expect(actualHeight).toBeGreaterThan(0);
    expect(expectedWidth).toBeGreaterThan(0);
    expect(expectedHeight).toBeGreaterThan(0);
    expect(actualWidth / actualHeight).toBeCloseTo(expectedWidth / expectedHeight, 2);
}

function expectSameResponsiveElementPresentation(
    actual: Awaited<ReturnType<typeof elementStyleSignature>>,
    expected: Awaited<ReturnType<typeof elementStyleSignature>>,
): void {
    const { width: actualWidth, height: actualHeight, ...actualVisualStyle } = actual;
    const { width: expectedWidth, height: expectedHeight, ...expectedVisualStyle } = expected;
    expect(actualVisualStyle).toEqual(expectedVisualStyle);
    expect(actualWidth).toBeGreaterThan(0);
    expect(actualHeight).toBeGreaterThan(0);
    expect(expectedWidth).toBeGreaterThan(0);
    expect(expectedHeight).toBeGreaterThan(0);
}

async function expectViewportEdgeScroller(page: Page): Promise<void> {
    const geometry = await page.getByTestId('conversation-transcript-list').evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(window.innerWidth - 1, rect.top + Math.min(40, rect.height / 2));
        return {
            clientHeight: element.clientHeight,
            documentScrollWidth: document.documentElement.scrollWidth,
            hitOwnedByScroller: hit === element || (hit !== null && element.contains(hit)),
            innerWidth: window.innerWidth,
            left: rect.left,
            overflowY: getComputedStyle(element).overflowY,
            right: rect.right,
            scrollHeight: element.scrollHeight,
            width: rect.width,
        };
    });
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight + 100);
    expect(['auto', 'scroll']).toContain(geometry.overflowY);
    expect(Math.abs(geometry.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.right - geometry.innerWidth)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.width - geometry.innerWidth)).toBeLessThanOrEqual(1);
    expect(geometry.hitOwnedByScroller).toBe(true);
    expect(geometry.documentScrollWidth).toBeLessThanOrEqual(geometry.innerWidth);
}

async function expectPublicSectionGeometry(page: Page, expectCover: boolean): Promise<void> {
    const geometry = await page.evaluate(() => {
        const cover = document.querySelector('[data-testid="public-session-cover"]');
        const header = document.querySelector('[data-testid="public-session-compact-header"]');
        const transcript = document.querySelector('[data-testid="public-session-transcript-scroll-region"]');
        if (!(header instanceof HTMLElement) || !(transcript instanceof HTMLElement)) {
            throw new Error('Missing public header/transcript geometry.');
        }
        const coverRect = cover instanceof HTMLElement ? cover.getBoundingClientRect() : null;
        const headerRect = header.getBoundingClientRect();
        const transcriptRect = transcript.getBoundingClientRect();
        const hit = document.elementFromPoint(window.innerWidth / 2, transcriptRect.top + 4);
        return {
            coverBottom: coverRect?.bottom ?? null,
            coverPresent: coverRect !== null,
            headerBottom: headerRect.bottom,
            headerTop: headerRect.top,
            hitHeader: hit === header || (hit !== null && header.contains(hit)),
            hitTranscript: hit === transcript || (hit !== null && transcript.contains(hit)),
            transcriptTop: transcriptRect.top,
        };
    });
    expect(geometry.coverPresent).toBe(expectCover);
    if (expectCover) expect(geometry.coverBottom!).toBeLessThanOrEqual(geometry.headerTop + 1);
    expect(geometry.headerBottom).toBeLessThanOrEqual(geometry.transcriptTop + 1);
    expect(geometry.hitHeader).toBe(false);
    expect(geometry.hitTranscript).toBe(true);
}

async function expectLowHeightDialogContract(page: Page): Promise<void> {
    const dialog = page.getByTestId('public-session-share-dialog');
    const scroll = page.getByTestId('public-session-share-scroll');
    const background = page.getByTestId('conversation-transcript-list');
    const backgroundGeometry = await background.evaluate((element) => {
        element.scrollTop = Math.min(240, element.scrollHeight - element.clientHeight);
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
        return {
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
            scrollTop: element.scrollTop,
        };
    });
    expect(backgroundGeometry.scrollHeight).toBeGreaterThan(backgroundGeometry.clientHeight);
    expect(backgroundGeometry.scrollTop).toBeGreaterThan(0);
    const backgroundScrollTop = backgroundGeometry.scrollTop;
    const dialogGeometry = await dialog.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
            bottom: rect.bottom,
            height: rect.height,
            left: rect.left,
            right: rect.right,
            top: rect.top,
            viewportHeight: window.innerHeight,
            viewportWidth: window.innerWidth,
        };
    });
    expect(dialogGeometry.top).toBeGreaterThanOrEqual(16);
    expect(dialogGeometry.left).toBeGreaterThanOrEqual(16);
    expect(dialogGeometry.bottom).toBeLessThanOrEqual(dialogGeometry.viewportHeight - 16);
    expect(dialogGeometry.right).toBeLessThanOrEqual(dialogGeometry.viewportWidth - 16);
    expect(dialogGeometry.height).toBeLessThanOrEqual(dialogGeometry.viewportHeight - 32);

    await scroll.evaluate((element) => { element.scrollTop = 0; });
    await expect(page.getByTestId('public-session-share-privacy-message')).toBeInViewport();
    await scroll.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await expect(page.getByTestId('public-session-share-create')).toBeInViewport();
    const scrollBox = await scroll.boundingBox();
    expect(scrollBox).not.toBeNull();
    await page.mouse.move(scrollBox!.x + scrollBox!.width / 2, scrollBox!.y + scrollBox!.height / 2);
    await page.mouse.wheel(0, 900);
    await expect.poll(() => background.evaluate((element) => element.scrollTop)).toBe(backgroundScrollTop);
}

async function markAndScrollTranscript(page: Page): Promise<number> {
    return page.getByTestId('conversation-transcript-list').evaluate((element) => {
        const target = Math.min(640, element.scrollHeight - element.clientHeight);
        if (target <= 0) throw new Error('The long transcript fixture did not create a vertical scroll range.');
        (element as HTMLElement).dataset.e2eTranscriptInstance = 'public-share-stable-instance';
        element.scrollTop = target;
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
        return target;
    });
}

async function expectTranscriptPreserved(page: Page, expectedScrollTop: number): Promise<void> {
    await expect.poll(() => page.getByTestId('conversation-transcript-list').evaluate((element) => ({
        marker: (element as HTMLElement).dataset.e2eTranscriptInstance,
        scrollTop: Math.round(element.scrollTop),
    }))).toEqual({ marker: 'public-share-stable-instance', scrollTop: Math.round(expectedScrollTop) });
}

async function coverImageSource(page: Page): Promise<string> {
    return page.getByTestId('public-session-cover-image').evaluate((element) => {
        const image = element instanceof HTMLImageElement ? element : element.querySelector('img');
        if (image instanceof HTMLImageElement) return image.currentSrc || image.src;
        const match = getComputedStyle(element).backgroundImage.match(/^url\(["']?(.*?)["']?\)$/);
        if (!match) throw new Error('Public cover did not expose an image source.');
        return match[1];
    });
}

async function expectCoverLoaded(page: Page, publicId: string, assetId: string): Promise<void> {
    const cover = page.getByTestId('public-session-cover-image');
    await expect(cover).toBeVisible();
    await expect.poll(() => cover.evaluate((element) => {
        const image = element instanceof HTMLImageElement ? element : element.querySelector('img');
        return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
    })).toBe(true);
    const source = new URL(await coverImageSource(page));
    expect(source.pathname).toBe(
        `/v1/public/session-shares/${encodeURIComponent(publicId)}/attachments/${encodeURIComponent(assetId)}`,
    );
}

async function expectDialogCoverLoaded(page: Page): Promise<void> {
    const preview = page.getByTestId('public-share-cover-preview');
    await expect(preview).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => preview.evaluate((element) => {
        const image = element instanceof HTMLImageElement ? element : element.querySelector('img');
        return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
    })).toBe(true);
}

test('V2 owner dialog exposes seven themes and resilient cover actions, then publishes an anonymous immutable cover', async ({ browser, page, request }, testInfo) => {
    test.setTimeout(600_000);
    let sessionId: string | null = null;
    let publicId: string | null = null;
    const cleanupTargets: ShareCleanupTarget[] = [];
    let cleanupRequired = true;
    let primaryFailure: unknown;
    let revokedResponsePhase = false;
    const diagnostics = createBrowserDiagnostics({
        allowedAbortUrlPrefixes: () => [
            `${authenticatedWebOrigin}/assets/`,
            `blob:${authenticatedWebOrigin}/`,
            ...(publicId ? [
                `${authenticatedWebOrigin}/v1/public/session-shares/${encodeURIComponent(publicId)}/attachments/`,
                `${e2eServerOrigin}/v1/public/session-shares/${encodeURIComponent(publicId)}/attachments/`,
            ] : []),
        ],
        expectedResponses: () => [
        ...(sessionId ? [{
            enabled: () => true,
            expectedCount: 1,
            label: 'owner random-cover provider unavailable',
            method: 'GET',
            origin: e2eServerOrigin,
            pathname: `/v1/sessions/${encodeURIComponent(sessionId)}/share/covers/random`,
            status: 503,
        }] : []),
        ...(publicId ? [{
            enabled: () => revokedResponsePhase,
            expectedCount: 1,
            label: 'revoked public snapshot',
            method: 'GET',
            origin: authenticatedWebOrigin,
            pathname: `/v1/public/session-shares/${encodeURIComponent(publicId)}`,
            status: 404,
        }] : []),
        ],
    });
    await diagnostics.monitorPage(page);
    try {
    sessionId = await createSession(request);
    cleanupTargets.push({ label: 'owner dialog fixture', sessionId });
    await appendConversation(request, sessionId);
    await page.route('**/v1/public/session-shares/**', proxyAnonymousPublicRequest);
    await page.setViewportSize({ width: 1440, height: 900 });
    await enableGinghamDark(page);
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

    await page.setViewportSize({ width: 1280, height: 720 });
    await openShareDialog(page);
    await expectLowHeightDialogContract(page);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('public-session-share-dialog')).toHaveCount(0);
    await expect(page.locator('[data-testid="session-header-more-button"]:visible')).toBeFocused();
    await openShareDialog(page);
    await expect(page.getByTestId('public-session-share-privacy-message')).toContainText('all attachments');
    await expect(page.getByTestId('public-share-appearance-controls')).toBeVisible();
    await expect(page.getByRole('radio')).toHaveCount(7);
    for (const themePack of themePackIds) {
        const swatch = page.getByRole('radio', { name: `Theme color: ${themePack}`, exact: true });
        await swatch.click();
        await expectSelectedTheme(page, themePack);
    }
    await page.getByRole('radio', { name: 'Theme color: gingham', exact: true }).click();

    const randomCoverRequestProblems: string[] = [];
    let randomCoverRequestCount = 0;
    const expectedRandomCoverOrigin = new URL(e2eServerUrl).origin;
    const expectedRandomCoverPath = `/v1/sessions/${encodeURIComponent(sessionId)}/share/covers/random`;
    let releaseRandomCover!: () => void;
    const randomCoverGate = new Promise<void>((resolveGate) => { releaseRandomCover = resolveGate; });
    await page.route('**/v1/sessions/**/share/covers/random*', async (route) => {
        randomCoverRequestCount += 1;
        const randomRequest = route.request();
        const randomUrl = new URL(randomRequest.url());
        const headers = await randomRequest.allHeaders();
        if (randomRequest.method() !== 'GET') randomCoverRequestProblems.push(`method=${randomRequest.method()}`);
        if (randomUrl.origin !== expectedRandomCoverOrigin) randomCoverRequestProblems.push(`origin=${randomUrl.origin}`);
        if (randomUrl.pathname !== expectedRandomCoverPath) randomCoverRequestProblems.push(`path=${randomUrl.pathname}`);
        if (randomUrl.search !== '') randomCoverRequestProblems.push(`search=${randomUrl.search}`);
        if (headers.authorization !== ownerHeaders().Authorization) randomCoverRequestProblems.push('owner Authorization missing or malformed');
        await randomCoverGate;
        await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Pexels cover provider is unavailable' }),
        });
    });
    const randomRequestStarted = page.waitForRequest((request) => (
        new URL(request.url()).pathname === expectedRandomCoverPath
    ));
    await page.getByTestId('public-share-cover-random').click();
    await randomRequestStarted;
    await expect(page.getByTestId('public-session-share-create')).toBeDisabled();
    await expect(page.getByTestId('public-share-appearance-controls')).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByTestId('public-share-cover-replacement-state'))
        .toHaveAttribute('aria-live', 'polite');
    await expect(page.getByTestId('public-share-cover-replacement-state')).toBeVisible();
    releaseRandomCover();
    await expect(page.getByTestId('public-share-cover-provider-state'))
        .toContainText('Pexels is unavailable. You can still upload an image or share without a cover.');
    expect(randomCoverRequestProblems).toEqual([]);
    expect(randomCoverRequestCount).toBe(1);
    await expect(page.getByTestId('public-session-share-create')).toBeEnabled();

    const fileChooser = page.waitForEvent('filechooser');
    await page.getByTestId('public-share-cover-upload').click();
    await (await fileChooser).setFiles(coverFixturePath);
    await expectDialogCoverLoaded(page);
    await expect(page.getByTestId('public-share-cover-provider-state')).toHaveCount(0);
    await expect(page.getByTestId('public-share-cover-remove')).toBeEnabled();

    await page.getByTestId('public-session-share-create').click();
    await expect(page.getByTestId('public-session-share-copy')).toBeVisible({ timeout: 120_000 });
    const publicUrl = (await page.getByText(/\/share\//).first().textContent())?.trim();
    expect(publicUrl).toMatch(/^http:\/\/localhost:\d+\/share\/[A-Za-z0-9_-]+$/);
    publicId = new URL(publicUrl!).pathname.split('/').pop()!;
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(publicUrl!).origin });
    await page.getByTestId('public-session-share-copy').click();
    await expect(page.getByTestId('public-session-share-copy-feedback'))
        .toHaveAttribute('aria-live', 'polite');
    await expect(page.getByTestId('public-session-share-copy-feedback')).toHaveText('Public link copied');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(publicUrl);
    await page.getByTestId('public-session-share-scroll').evaluate((element) => { element.scrollTop = 0; });
    await expectSelectedTheme(page, 'gingham');
    await expectDialogCoverLoaded(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: currentEvidencePath(testInfo, 'case-1-share-dialog-after.png'), fullPage: false });

    const publicApiResponse = await request.get(
        new URL(`/v1/public/session-shares/${encodeURIComponent(publicId)}`, e2eServerUrl).toString(),
    );
    expect(publicApiResponse.ok()).toBe(true);
    const publicPayload = await publicApiResponse.json() as { snapshot: SnapshotV2 };
    expect(publicPayload.snapshot.version).toBe(2);
    expect(publicPayload.snapshot.appearance.themePack).toBe('gingham');
    const cover = publicPayload.snapshot.appearance.cover;
    expect(cover).toMatchObject({ mimeType: 'image/png', width: 1600, height: 1000 });
    expect(cover?.attribution).toBeUndefined();
    const attachment = publicPayload.snapshot.messages
        .flatMap((message) => message.blocks)
        .find((block) => block.type === 'attachment');
    expect(attachment).toMatchObject({ type: 'attachment', name: '发布演示.mp4' });
    const attachmentResponse = await request.get(
        new URL(
            `/v1/public/session-shares/${encodeURIComponent(publicId)}/attachments/${encodeURIComponent(attachment!.attachmentId!)}`,
            e2eServerUrl,
        ).toString(),
    );
    expect(attachmentResponse.ok()).toBe(true);
    expect(Buffer.from(await attachmentResponse.body()).equals(readFileSync(videoFixturePath))).toBe(true);
    const coverResponse = await request.get(
        new URL(
            `/v1/public/session-shares/${encodeURIComponent(publicId)}/attachments/${encodeURIComponent(cover!.assetId)}`,
            e2eServerUrl,
        ).toString(),
    );
    expect(coverResponse.ok()).toBe(true);
    expect(Buffer.from(await coverResponse.body()).equals(readFileSync(coverFixturePath))).toBe(true);

    const anonymousContext = await browser.newContext({
        colorScheme: 'dark',
        locale: 'en-US',
        viewport: { width: 1440, height: 900 },
    });
    try {
        expect(await anonymousContext.cookies()).toEqual([]);
        const anonymousPage = await anonymousContext.newPage();
        await diagnostics.monitorPage(anonymousPage);
        await anonymousPage.route('**/v1/public/session-shares/**', proxyAnonymousPublicRequest);
        await anonymousPage.goto(publicUrl!, { waitUntil: 'domcontentloaded', timeout: 180_000 });
        await expectAnonymousReadOnly(anonymousPage);
        await expectPublicPageColor(anonymousPage, 'rgb(18, 24, 33)');
        await expectSelectedMode(anonymousPage, 'System');
        await expect(anonymousPage.getByText('[PUBLIC-SESSION-SHARE] 产品发布检查清单', { exact: true })).toBeVisible();
        await expect(anonymousPage.getByText('请确认公开分享页只展示对话正文和全部附件。', { exact: true })).toBeVisible();
        await expect(anonymousPage.getByText('已检查：这是一次不可继续输入、可随时撤销的公开快照。', { exact: true })).toBeVisible();
        await expect(anonymousPage.locator('video')).toBeVisible();
        await expectCoverLoaded(anonymousPage, publicId, cover!.assetId);
        expectSameLayout(await messageStyleSignature(
            anonymousPage,
            'message-user-',
            '请确认公开分享页只展示对话正文和全部附件。',
        ), authenticatedUserStyle);
        expectSameLayout(await messageStyleSignature(
            anonymousPage,
            'message-agent-',
            '已检查：这是一次不可继续输入、可随时撤销的公开快照。',
        ), authenticatedAgentStyle);
        expectSameMediaPresentation(
            await elementStyleSignature(anonymousPage, 'media-attachment-player-generated'),
            authenticatedVideoStyle,
        );
        const publicWorkToggle = anonymousPage.getByTestId('conversation-agent-work-toggle').first();
        await expect(publicWorkToggle).toBeVisible();
        expect((await publicWorkToggle.textContent())?.trim()).toBe(authenticatedWorkLabel);
        expectSameResponsiveElementPresentation(
            await elementStyleSignature(anonymousPage, 'conversation-agent-work-toggle'),
            authenticatedWorkStyle,
        );
        const publicWorkGeometry = await publicWorkToggle.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            const containerBounds = element.parentElement?.getBoundingClientRect();
            return {
                bottom: bounds.bottom,
                containerBottom: containerBounds?.bottom ?? Number.NEGATIVE_INFINITY,
                containerLeft: containerBounds?.left ?? Number.POSITIVE_INFINITY,
                containerRight: containerBounds?.right ?? Number.NEGATIVE_INFINITY,
                containerTop: containerBounds?.top ?? Number.POSITIVE_INFINITY,
                left: bounds.left,
                right: bounds.right,
                top: bounds.top,
            };
        });
        expect(publicWorkGeometry.left).toBeGreaterThanOrEqual(publicWorkGeometry.containerLeft);
        expect(publicWorkGeometry.right).toBeLessThanOrEqual(publicWorkGeometry.containerRight);
        expect(publicWorkGeometry.top).toBeGreaterThanOrEqual(publicWorkGeometry.containerTop);
        expect(publicWorkGeometry.bottom).toBeLessThanOrEqual(publicWorkGeometry.containerBottom);
        await publicWorkToggle.click();
        await expect(anonymousPage.getByTestId('conversation-tool-group-toggle').first()).toBeVisible();
        await publicWorkToggle.click();
        await expect(anonymousPage.getByTestId('conversation-tool-group-toggle')).toHaveCount(0);
        await expect(anonymousPage.getByRole('heading', { name: '[PUBLIC-SESSION-SHARE] 产品发布检查清单' }))
            .toHaveCSS('font-size', '22px');
        await expectLoadedVectorIcon(anonymousPage.getByTestId('public-session-header-icon'));
        await expectLoadedVectorIcon(anonymousPage.getByTestId('public-session-time-icon'));
        await expectLoadedVectorIcon(publicWorkToggle.getByTestId('conversation-tool-summary-icon'));
        await expectLoadedVectorIcon(publicWorkToggle.getByTestId('conversation-collapse-chevron'));
    } finally {
        await anonymousContext.close();
    }

    const revokeResponsePromise = page.waitForResponse((response) => (
        response.request().method() === 'DELETE' && response.url().endsWith(`/v1/sessions/${sessionId}/share`)
    ));
    await page.getByTestId('public-session-share-revoke').click();
    await expect(page.getByTestId('public-session-share-revoke-confirmation')).toBeVisible();
    await page.getByTestId('public-session-share-revoke-confirm').click();
    expect((await revokeResponsePromise).status()).toBe(200);
    cleanupRequired = false;
    await expect(page.getByTestId('public-session-share-create')).toBeVisible({ timeout: 30_000 });
    const revokedResponse = await request.get(
        new URL(`/v1/public/session-shares/${encodeURIComponent(publicId)}`, e2eServerUrl).toString(),
    );
    expect(revokedResponse.status()).toBe(404);
    const revokedContext = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
    try {
        const revokedPage = await revokedContext.newPage();
        await diagnostics.monitorPage(revokedPage);
        await revokedPage.route('**/v1/public/session-shares/**', proxyAnonymousPublicRequest);
        revokedResponsePhase = true;
        await revokedPage.goto(publicUrl!, { waitUntil: 'domcontentloaded', timeout: 180_000 });
        await expect(revokedPage.getByTestId('public-session-share-unavailable')).toBeVisible({ timeout: 180_000 });
        await expect(revokedPage.getByText('This shared session is unavailable', { exact: true })).toBeVisible();
    } finally {
        revokedResponsePhase = false;
        await revokedContext.close();
    }
    expect(randomCoverRequestCount).toBe(1);
    diagnostics.expectClean();
    } catch (error) {
        primaryFailure = error;
        throw error;
    } finally {
        if (cleanupRequired) await cleanupShares(request, cleanupTargets, primaryFailure);
    }
});

test('historical V1 and coverless V2 shares remain anonymous, compact, and usable at desktop and phone widths', async ({ browser, request }, testInfo) => {
    test.setTimeout(600_000);
    const sharedAt = Date.UTC(2026, 8, 3, 4, 5, 0);
    const cleanupTargets: ShareCleanupTarget[] = [];
    let primaryFailure: unknown;
    let publicIds: string[] = [];
    const diagnostics = createBrowserDiagnostics({
        allowedAbortUrlPrefixes: () => [
            `${authenticatedWebOrigin}/assets/`,
            `blob:${authenticatedWebOrigin}/`,
            ...publicIds.map((publicId) => (
                `${authenticatedWebOrigin}/v1/public/session-shares/${encodeURIComponent(publicId)}/attachments/`
            )),
        ],
    });
    try {
    const v1 = await publishDirectSnapshot(request, {
        version: 1,
        title: 'Historical V1 public session',
        sharedAt,
        source: { provider: 'codex' },
        presentation: { groupToolCalls: true },
        messages: longMessages('V1', 36),
    }, (target) => cleanupTargets.push(target));
    const coverlessV2 = await publishDirectSnapshot(request, {
        version: 2,
        title: 'Coverless V2 public session',
        sharedAt: sharedAt + 1,
        source: { provider: 'paws' },
        presentation: { groupToolCalls: true },
        messages: longMessages('V2 coverless', 52),
        appearance: { themePack: 'sage' },
    }, (target) => cleanupTargets.push(target));
    publicIds = [v1.publicId, coverlessV2.publicId];

    const context = await browser.newContext({
        colorScheme: 'dark',
        locale: 'en-US',
        viewport: { width: 1440, height: 900 },
    });
    try {
        const page = await context.newPage();
        await diagnostics.monitorPage(page);
        await page.route('**/v1/public/session-shares/**', proxyAnonymousPublicRequest);

        await page.goto(v1.publicUrl, { waitUntil: 'domcontentloaded', timeout: 180_000 });
        await expectAnonymousReadOnly(page);
        await expect(page.getByText('V1: anonymous public snapshot.', { exact: true })).toBeVisible();
        await expect(page.getByTestId('public-session-cover')).toHaveCount(0);
        await expectPublicPageColor(page, 'rgb(26, 21, 18)');

        await page.goto(coverlessV2.publicUrl, { waitUntil: 'domcontentloaded', timeout: 180_000 });
        await expectAnonymousReadOnly(page);
        await expect(page.getByText('V2 coverless: anonymous public snapshot.', { exact: true })).toBeVisible();
        await expect(page.getByTestId('public-session-cover')).toHaveCount(0);
        await expectPublicPageColor(page, 'rgb(18, 23, 15)');
        const headerTop = await page.getByTestId('public-session-compact-header').evaluate((element) => (
            Math.round(element.getBoundingClientRect().top)
        ));
        expect(headerTop).toBeLessThanOrEqual(1);
        await expectViewportEdgeScroller(page);
        await expectPublicSectionGeometry(page, false);
        await page.screenshot({ path: currentEvidencePath(testInfo, 'case-3-no-cover-after.png'), fullPage: false });

        await page.setViewportSize({ width: 390, height: 844 });
        await expect(page.getByTestId('public-session-transcript')).toBeVisible();
        await expect(page.getByTestId('public-session-cover')).toHaveCount(0);
        await expect(page.getByTestId('public-session-title')).toBeVisible();
        const mobileGeometry = await page.evaluate(() => {
            const control = document.querySelector('[data-testid="public-session-appearance-mode"]');
            const header = document.querySelector('[data-testid="public-session-header-inner"]');
            if (!(control instanceof HTMLElement) || !(header instanceof HTMLElement)) {
                throw new Error('Missing compact public header geometry.');
            }
            const controlRect = control.getBoundingClientRect();
            const headerRect = header.getBoundingClientRect();
            return {
                controlLeft: controlRect.left,
                controlRight: controlRect.right,
                headerLeft: headerRect.left,
                headerRight: headerRect.right,
                scrollWidth: document.documentElement.scrollWidth,
                viewportWidth: window.innerWidth,
            };
        });
        expect(mobileGeometry.controlLeft).toBeGreaterThanOrEqual(0);
        expect(mobileGeometry.controlRight).toBeLessThanOrEqual(mobileGeometry.viewportWidth);
        expect(mobileGeometry.headerLeft).toBeGreaterThanOrEqual(0);
        expect(mobileGeometry.headerRight).toBeLessThanOrEqual(mobileGeometry.viewportWidth);
        expect(mobileGeometry.scrollWidth).toBeLessThanOrEqual(mobileGeometry.viewportWidth);
        await expectViewportEdgeScroller(page);
        await expectPublicSectionGeometry(page, false);
        await page.screenshot({
            path: currentEvidencePath(testInfo, 'supplemental/case-3-no-cover-390x844.png'),
            fullPage: false,
        });
        diagnostics.expectClean();
    } finally {
        await context.close();
    }
    } catch (error) {
        primaryFailure = error;
        throw error;
    } finally {
        await cleanupShares(request, cleanupTargets, primaryFailure);
    }
});

test('deterministic Pexels V2 renderer keeps mode storage and the mounted transcript stable across IDs, reloads, and system changes', async ({ browser }, testInfo) => {
    test.setTimeout(600_000);
    const coverBytes = readFileSync(coverFixturePath);
    const coverAssetId = 'f4f39a1b-3d5e-4b5f-8f35-6a9f1f6788c1';
    const coveredPublicId = 'pexels-renderer-v2';
    const historicalPublicId = 'historical-renderer-v1';
    const publishedAt = Date.UTC(2026, 8, 3, 4, 10, 0);
    const coveredSnapshot: SnapshotV2 = {
        version: 2,
        title: 'Gingham release story',
        sharedAt: publishedAt,
        source: { provider: 'codex' },
        presentation: { groupToolCalls: true },
        messages: longMessages('Gingham V2', 96),
        appearance: {
            themePack: 'gingham',
            cover: {
                assetId: coverAssetId,
                mimeType: 'image/png',
                size: coverBytes.length,
                width: 1600,
                height: 1000,
                attribution: {
                    photoId: 2014422,
                    photographer: 'Ada Lovelace',
                    photographerUrl: 'https://www.pexels.com/@ada-lovelace/',
                    photoUrl: 'https://www.pexels.com/photo/2014422/',
                },
            },
        },
    };
    const historicalSnapshot: PublicSessionSnapshot = {
        version: 1,
        title: 'Historical cross-ID appearance fixture',
        sharedAt: publishedAt - 1,
        source: { provider: 'codex' },
        presentation: { groupToolCalls: true },
        messages: longMessages('Historical cross-ID V1', 28),
    };
    const diagnostics = createBrowserDiagnostics({
        allowedAbortUrlPrefixes: () => [
            `${authenticatedWebOrigin}/assets/`,
            `blob:${authenticatedWebOrigin}/`,
            `${authenticatedWebOrigin}/v1/public/session-shares/${coveredPublicId}/attachments/`,
        ],
    });

    const context = await browser.newContext({
        colorScheme: 'dark',
        locale: 'en-US',
        viewport: { width: 1440, height: 900 },
    });
    try {
        await context.addInitScript(() => {
            const state = window as typeof window & {
                __publicShareOpenedUrl?: { features?: string; target?: string; url: string };
            };
            window.open = ((url?: string | URL, target?: string, features?: string) => {
                state.__publicShareOpenedUrl = { features, target, url: String(url) };
                return null;
            }) as typeof window.open;
        });
        const page = await context.newPage();
        await diagnostics.monitorPage(page);
        await page.route('**/v1/public/session-shares/**', async (route) => {
            const requestUrl = new URL(route.request().url());
            const headers = await route.request().allHeaders();
            expect(headers.authorization).toBeUndefined();
            expect(headers.cookie).toBeUndefined();
            const segments = requestUrl.pathname.split('/').filter(Boolean);
            const publicId = decodeURIComponent(segments[3] ?? '');
            const assetId = decodeURIComponent(segments[5] ?? '');
            if (segments.length === 4 && publicId === coveredPublicId) {
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({ snapshot: coveredSnapshot, publishedAt }),
                });
                return;
            }
            if (segments.length === 4 && publicId === historicalPublicId) {
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({ snapshot: historicalSnapshot, publishedAt: publishedAt - 1 }),
                });
                return;
            }
            if (segments.length === 6 && publicId === coveredPublicId && assetId === coverAssetId) {
                await route.fulfill({
                    status: 200,
                    contentType: 'image/png',
                    body: coverBytes,
                });
                return;
            }
            await route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not found"}' });
        });

        await page.goto(publicRoute(coveredPublicId), { waitUntil: 'domcontentloaded', timeout: 180_000 });
        await expectAnonymousReadOnly(page);
        await expectSelectedMode(page, 'System');
        await expectPublicPageColor(page, 'rgb(18, 24, 33)');
        await expectCoverLoaded(page, coveredPublicId, coverAssetId);
        await expectPublicSectionGeometry(page, true);
        await expectModeTooltips(page);
        for (const label of ['Light', 'Dark', 'System']) {
            await expect(page.getByRole('button', { name: label, exact: true })).not.toHaveAttribute('aria-selected');
        }
        const attributionLink = page.getByRole('link', { name: 'Photo by Ada Lovelace on Pexels', exact: true });
        await expect(attributionLink).toBeVisible();
        await expect(page.getByTestId('public-session-cover-attribution')).toContainText('Photo by Ada Lovelace on Pexels');
        await attributionLink.click();
        const openedAttribution = await page.evaluate(() => (
            window as typeof window & {
                __publicShareOpenedUrl?: { features?: string; target?: string; url: string };
            }
        ).__publicShareOpenedUrl);
        expect(openedAttribution).toEqual({
            features: 'noopener',
            target: '_blank',
            url: coveredSnapshot.appearance.cover!.attribution!.photoUrl,
        });
        const attributionUrl = new URL(openedAttribution!.url);
        expect({
            hash: attributionUrl.hash,
            hostname: attributionUrl.hostname,
            password: attributionUrl.password,
            pathname: attributionUrl.pathname,
            protocol: attributionUrl.protocol,
            search: attributionUrl.search,
            username: attributionUrl.username,
        }).toEqual({
            hash: '',
            hostname: 'www.pexels.com',
            password: '',
            pathname: '/photo/2014422/',
            protocol: 'https:',
            search: '',
            username: '',
        });
        expect(await context.cookies('https://www.pexels.com')).toEqual([]);
        await expectViewportEdgeScroller(page);

        const initialScrollTop = await markAndScrollTranscript(page);
        await page.getByRole('button', { name: 'Light', exact: true }).click();
        await expectSelectedMode(page, 'Light');
        await expectPublicPageColor(page, 'rgb(244, 247, 250)');
        expect(await page.evaluate((key) => localStorage.getItem(key), appearanceStorageKey)).toBe('light');
        await expectTranscriptPreserved(page, initialScrollTop);
        await expectPublicSectionGeometry(page, true);

        await page.getByRole('button', { name: 'Dark', exact: true }).click();
        await expectSelectedMode(page, 'Dark');
        await expectPublicPageColor(page, 'rgb(18, 24, 33)');
        expect(await page.evaluate((key) => localStorage.getItem(key), appearanceStorageKey)).toBe('dark');
        await expectTranscriptPreserved(page, initialScrollTop);

        const transcript = page.getByTestId('conversation-transcript-list');
        await transcript.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
            element.dispatchEvent(new Event('scroll', { bubbles: true }));
        });
        const codeScroll = page.getByTestId('markdown-code-scroll').filter({ hasText: 'pnpm test -- --grep public-session-share' });
        await expect(codeScroll).toBeVisible();
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(publicRoute(coveredPublicId)).origin });
        const copyButton = page.getByTestId('markdown-code-copy').first();
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        for (let index = 0; index < 80 && !(await copyButton.evaluate((element) => element === document.activeElement)); index += 1) {
            await page.keyboard.press('Tab');
        }
        await expect(copyButton).toBeFocused();
        await expect.poll(() => copyButton.evaluate((element) => getComputedStyle(element.parentElement!).opacity)).toBe('1');
        await page.keyboard.press('Enter');
        await expect(copyButton).toHaveAttribute('aria-label', 'Copied');
        await expect(page.getByTestId('markdown-code-copy-feedback')).toHaveAttribute('aria-live', 'polite');
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
            .toBe('pnpm test -- --grep public-session-share');
        await page.getByRole('button', { name: 'Dark', exact: true }).hover();
        await page.screenshot({ path: currentEvidencePath(testInfo, 'case-4-gingham-dark-after.png'), fullPage: false });
        await expect(copyButton).toHaveAttribute('aria-label', 'Copy', { timeout: 3_000 });

        await page.reload({ waitUntil: 'domcontentloaded', timeout: 180_000 });
        await expectAnonymousReadOnly(page);
        await expectSelectedMode(page, 'Dark');
        await expectPublicPageColor(page, 'rgb(18, 24, 33)');
        expect(await page.evaluate((key) => localStorage.getItem(key), appearanceStorageKey)).toBe('dark');

        await page.goto(publicRoute(historicalPublicId), { waitUntil: 'domcontentloaded', timeout: 180_000 });
        await expectAnonymousReadOnly(page);
        await expectSelectedMode(page, 'Dark');
        await expectPublicPageColor(page, 'rgb(26, 21, 18)');
        await expect(page.getByTestId('public-session-cover')).toHaveCount(0);

        await page.getByRole('button', { name: 'Light', exact: true }).click();
        await expectSelectedMode(page, 'Light');
        await expectPublicPageColor(page, 'rgb(251, 247, 240)');
        expect(await page.evaluate((key) => localStorage.getItem(key), appearanceStorageKey)).toBe('light');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 180_000 });
        await expectSelectedMode(page, 'Light');
        await expectPublicPageColor(page, 'rgb(251, 247, 240)');

        await page.goto(publicRoute(coveredPublicId), { waitUntil: 'domcontentloaded', timeout: 180_000 });
        await expectAnonymousReadOnly(page);
        await expectSelectedMode(page, 'Light');
        await expectPublicPageColor(page, 'rgb(244, 247, 250)');
        await expectCoverLoaded(page, coveredPublicId, coverAssetId);
        await page.getByTestId('conversation-transcript-list').evaluate((element) => { element.scrollTop = 0; });
        await expectPublicSectionGeometry(page, true);
        await page.screenshot({ path: currentEvidencePath(testInfo, 'case-2-public-cover-after.png'), fullPage: false });

        await page.getByRole('button', { name: 'System', exact: true }).click();
        await expectSelectedMode(page, 'System');
        await expectPublicPageColor(page, 'rgb(18, 24, 33)');
        expect(await page.evaluate((key) => localStorage.getItem(key), appearanceStorageKey)).toBe('system');
        const systemScrollTop = await markAndScrollTranscript(page);
        await page.emulateMedia({ colorScheme: 'light' });
        await expectPublicPageColor(page, 'rgb(244, 247, 250)');
        await expectTranscriptPreserved(page, systemScrollTop);
        await page.emulateMedia({ colorScheme: 'dark' });
        await expectPublicPageColor(page, 'rgb(18, 24, 33)');
        await expectTranscriptPreserved(page, systemScrollTop);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 180_000 });
        await expectSelectedMode(page, 'System');
        await expectPublicPageColor(page, 'rgb(18, 24, 33)');
        expect(await page.evaluate((key) => localStorage.getItem(key), appearanceStorageKey)).toBe('system');

        await page.goto(publicRoute(historicalPublicId), { waitUntil: 'domcontentloaded', timeout: 180_000 });
        await expectSelectedMode(page, 'System');
        await expectPublicPageColor(page, 'rgb(26, 21, 18)');
        await page.emulateMedia({ colorScheme: 'light' });
        await expectPublicPageColor(page, 'rgb(251, 247, 240)');
        diagnostics.expectClean();
    } finally {
        await context.close();
    }
});
