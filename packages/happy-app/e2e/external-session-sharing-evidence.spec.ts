import { expect, test, type APIRequestContext, type Page, type Route, type TestInfo } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const cliPath = process.env.HAPPY_EXTERNAL_SHARE_CLI_PATH!;
const shareHome = process.env.HAPPY_EXTERNAL_SHARE_HOME!;
const serverUrl = process.env.HAPPY_E2E_SERVER_URL!;
const webUrl = process.env.HAPPY_E2E_WEB_URL!;
const codexFixture = process.env.HAPPY_EXTERNAL_SHARE_CODEX_FIXTURE!;
const codexReplacementFixture = process.env.HAPPY_EXTERNAL_SHARE_CODEX_REPLACEMENT_FIXTURE!;
const claudeFixture = process.env.HAPPY_EXTERNAL_SHARE_CLAUDE_FIXTURE!;
const attachmentFixture = process.env.HAPPY_EXTERNAL_SHARE_ATTACHMENT_FIXTURE!;
const evidenceDirectory = process.env.HAPPY_EXTERNAL_SHARE_EVIDENCE_DIR;
const recordEvidence = process.env.HAPPY_E2E_RECORD === '1';

type PublishedShare = {
    publicUrl: string;
    publicId: string;
    expiresAt: string;
    source: 'codex' | 'claude-code';
    messageCount: number;
    attachmentCount: number;
    attachmentBytes: number;
    recordId: string;
};

type ManagedRecordFile = {
    version: 1;
    records: Array<{
        managementToken: string;
        publicId: string;
        shareId: string;
    }>;
};

function runCli(args: string[]): string {
    return execFileSync(cliPath, args, {
        cwd: join(codexFixture, '..'),
        encoding: 'utf8',
        env: {
            ...process.env,
            PAWS_SHARE_HOME: shareHome,
            PAWS_SHARE_SERVER_URL: serverUrl,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 180_000,
    });
}

function publish(provider: PublishedShare['source'], fixture: string): { result: PublishedShare; output: string } {
    const output = runCli([
        'share',
        '--source', provider,
        '--session', fixture,
        '--server', serverUrl,
        '--yes',
        '--json',
    ]);
    return { result: JSON.parse(output) as PublishedShare, output };
}

function anonymousViewerUrl(publicId: string): string {
    const url = new URL(webUrl);
    url.pathname = `/share/${encodeURIComponent(publicId)}`;
    url.search = '';
    url.hash = '';
    return url.toString();
}

function evidencePath(testInfo: TestInfo, filename: string): string {
    if (!evidenceDirectory) return testInfo.outputPath(filename);
    mkdirSync(evidenceDirectory, { recursive: true });
    return join(evidenceDirectory, filename);
}

async function proxyPublicRequests(route: Route): Promise<void> {
    const incoming = new URL(route.request().url());
    const upstream = new URL(`${incoming.pathname}${incoming.search}`, serverUrl);
    const headers = await route.request().allHeaders();
    delete headers.authorization;
    delete headers.cookie;
    const response = await route.fetch({ url: upstream.toString(), headers });
    await route.fulfill({ response });
}

async function expectPublicSnapshot(
    request: APIRequestContext,
    share: PublishedShare,
    expectedProvider: PublishedShare['source'],
    expectedAttachment: string,
): Promise<string> {
    const response = await request.get(
        new URL(`/v1/public/session-shares/${encodeURIComponent(share.publicId)}`, serverUrl).toString(),
    );
    expect(response.ok()).toBe(true);
    const payload = await response.json() as {
        snapshot: {
            source?: { provider?: string };
            messages: Array<{ blocks: Array<{ type: string; attachmentId?: string; name?: string }> }>;
        };
    };
    expect(payload.snapshot.source?.provider).toBe(expectedProvider);
    const attachment = payload.snapshot.messages
        .flatMap((message) => message.blocks)
        .find((block) => block.type === 'attachment');
    expect(attachment).toMatchObject({ type: 'attachment', name: expectedAttachment });
    expect(attachment?.attachmentId).toBeTruthy();
    return attachment!.attachmentId!;
}

async function expectReadOnlyTranscript(page: Page): Promise<void> {
    await expect(page.getByTestId('public-session-transcript')).toBeVisible({ timeout: 180_000 });
    await expect(page.getByTestId('conversation-transcript-list')).toBeVisible();
    await expect(page.getByTestId('public-session-compact-header')).toBeVisible();
    await expect(page.getByTestId('session-message-input')).toHaveCount(0);
    await expect(page.getByTestId('desktop-navigation-sidebar')).toHaveCount(0);
    await expect(page.getByTestId('desktop-right-panel')).toHaveCount(0);
    await expect(page.getByTestId('session-header-more-button')).toHaveCount(0);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex,nofollow,noarchive');
}

async function expectMessageText(page: Page, role: 'user' | 'agent', value: string): Promise<void> {
    const message = page.locator(`[data-testid^="message-${role}-"]`).filter({ hasText: value }).first();
    await expect(message).toBeVisible();
    await expect(message.getByText(value, { exact: true })).toBeVisible();
}

async function pauseForEvidence(page: Page): Promise<void> {
    if (recordEvidence) await page.waitForTimeout(1_600);
}

async function showRecordingStage(page: Page, title: string, detail: string): Promise<void> {
    if (!recordEvidence) return;
    await page.setContent(`
        <!doctype html>
        <html lang="en">
            <head><meta charset="utf-8"><title>${title}</title></head>
            <body style="margin:0;background:#fbf7f0;color:#3c332b;font-family:Inter,ui-sans-serif,system-ui,sans-serif">
                <main style="min-height:100vh;display:grid;place-items:center;padding:48px;box-sizing:border-box">
                    <section style="width:min(680px,100%);padding:42px;border:1px solid #eadfce;border-radius:22px;background:#fffdf9;box-shadow:0 18px 60px rgba(72,52,34,.08)">
                        <div style="display:flex;align-items:center;gap:12px;color:#c87432;font-size:14px;font-weight:700;letter-spacing:.08em;text-transform:uppercase">
                            <span style="display:grid;place-items:center;width:34px;height:34px;border-radius:11px;background:#c87432;color:white;font-size:20px">✓</span>
                            External session share · E2E
                        </div>
                        <h1 style="margin:28px 0 10px;font-size:32px;line-height:1.2">${title}</h1>
                        <p style="margin:0;color:#827466;font-size:18px;line-height:1.6">${detail}</p>
                        <p style="margin:28px 0 0;color:#aa9b8c;font-size:14px">Real packed CLI · isolated server · anonymous browser</p>
                    </section>
                </main>
            </body>
        </html>
    `, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1_600);
}

test('EXTERNAL-SESSION-SHARE packed CLI publishes Codex and Claude Code snapshots with attachments, then revokes by local capability', async ({ page, request }, testInfo) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.addInitScript((showLoadingStage) => {
        const install = () => {
            const style = document.createElement('style');
            style.textContent = '.__expo_fast_refresh { display: none !important; }';
            document.head.appendChild(style);
            if (!showLoadingStage || !location.pathname.startsWith('/share/')) return;
            const loading = document.createElement('div');
            loading.id = 'external-share-e2e-loading';
            loading.innerHTML = `
                <section style="width:min(520px,calc(100% - 64px));padding:36px;border:1px solid #eadfce;border-radius:20px;background:#fffdf9;box-shadow:0 18px 60px rgba(72,52,34,.08);font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#3c332b">
                    <strong style="display:block;color:#c87432;font-size:13px;letter-spacing:.08em;text-transform:uppercase">Anonymous viewer</strong>
                    <h1 style="margin:18px 0 8px;font-size:27px">Loading the public snapshot…</h1>
                    <p style="margin:0;color:#827466;font-size:16px;line-height:1.6">No account, side panels, or composer will be loaded.</p>
                </section>
            `;
            Object.assign(loading.style, {
                alignItems: 'center',
                background: '#fbf7f0',
                display: 'flex',
                inset: '0',
                justifyContent: 'center',
                position: 'fixed',
                zIndex: '2147483647',
            });
            document.body.appendChild(loading);
            const observer = new MutationObserver(() => {
                if (!document.querySelector('[data-testid="public-session-transcript"], [data-testid="public-session-share-unavailable"]')) return;
                loading.remove();
                observer.disconnect();
            });
            observer.observe(document.body, { childList: true, subtree: true });
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
        else install();
    }, recordEvidence);
    await page.route('**/v1/public/session-shares/**', proxyPublicRequests);

    try {
        await showRecordingStage(
            page,
            'Publishing two public snapshots',
            'The npm tarball CLI is converting Codex and Claude Code JSONL, scanning the export, and uploading every attachment.',
        );
        const codexInspection = runCli(['inspect', '--source', 'codex', '--session', codexFixture, '--json']);
        expect(JSON.parse(codexInspection)).toMatchObject({
            source: 'codex',
            attachmentCount: 1,
            unresolvedAttachmentCount: 0,
            blockingFindingCount: 0,
        });

        const codex = publish('codex', codexFixture);
        const claude = publish('claude-code', claudeFixture);
        expect(codex.result).toMatchObject({ source: 'codex', attachmentCount: 1 });
        expect(claude.result).toMatchObject({ source: 'claude-code', attachmentCount: 1 });

        const recordPath = join(shareHome, 'shares.json');
        const records = JSON.parse(readFileSync(recordPath, 'utf8')) as ManagedRecordFile;
        expect(records.records).toHaveLength(2);
        expect(statSync(shareHome).mode & 0o777).toBe(0o700);
        expect(statSync(recordPath).mode & 0o777).toBe(0o600);
        for (const record of records.records) {
            if ([codexInspection, codex.output, claude.output].some((output) => output.includes(record.managementToken))) {
                throw new Error('Packed CLI exposed a management capability in command output');
            }
        }
        const publicList = runCli(['list', '--json']);
        if (publicList.includes('managementToken')) {
            throw new Error('Packed CLI list output exposed a management capability field');
        }
        expect(JSON.parse(publicList)).toHaveLength(2);

        await showRecordingStage(
            page,
            'Snapshots published successfully',
            'Opening the same public conversation renderer as an anonymous, read-only viewer.',
        );

        const fixtureBytes = readFileSync(attachmentFixture);
        const codexAttachmentId = await expectPublicSnapshot(
            request,
            codex.result,
            'codex',
            basename(attachmentFixture),
        );
        const claudeAttachmentId = await expectPublicSnapshot(
            request,
            claude.result,
            'claude-code',
            basename(attachmentFixture),
        );
        for (const [share, attachmentId] of [
            [codex.result, codexAttachmentId],
            [claude.result, claudeAttachmentId],
        ] as const) {
            const attachmentResponse = await request.get(new URL(
                `/v1/public/session-shares/${encodeURIComponent(share.publicId)}/attachments/${encodeURIComponent(attachmentId)}`,
                serverUrl,
            ).toString());
            expect(attachmentResponse.ok()).toBe(true);
            expect(await attachmentResponse.body()).toEqual(fixtureBytes);
        }

        await page.goto(anonymousViewerUrl(codex.result.publicId), { waitUntil: 'domcontentloaded', timeout: 180_000 });
        await expectReadOnlyTranscript(page);
        await expect(page.getByTestId('public-session-source-label')).toHaveText('Codex');
        await expectMessageText(page, 'user', 'Create a purple Paws sharing illustration.');
        await expectMessageText(page, 'agent', 'The illustration is ready and keeps the same aspect ratio.');
        const codexWork = page.getByTestId('conversation-agent-work-toggle').first();
        await expect(codexWork).toBeVisible();
        await expect(page.getByTestId('conversation-tool-group-toggle')).toHaveCount(0);
        await pauseForEvidence(page);
        await codexWork.click();
        await expect(page.getByTestId('conversation-tool-group-toggle').first()).toBeVisible();
        await pauseForEvidence(page);
        await page.screenshot({ path: evidencePath(testInfo, 'codex-public-snapshot.png'), fullPage: true });

        const statusOutput = runCli(['status', codex.result.publicId, '--json']);
        if (records.records.some((record) => statusOutput.includes(record.managementToken))) {
            throw new Error('Packed CLI status output exposed a management capability');
        }
        expect(JSON.parse(statusOutput)).toMatchObject({
            publicId: codex.result.publicId,
            publicUrl: codex.result.publicUrl,
            active: true,
            revoked: false,
            source: 'codex',
        });

        await showRecordingStage(
            page,
            'Replacing the snapshot in place',
            'The local management capability updates the content while preserving the original public URL.',
        );
        const replaceOutput = runCli([
            'replace', codex.result.publicId,
            '--source', 'codex',
            '--session', codexReplacementFixture,
            '--yes',
            '--json',
        ]);
        if (records.records.some((record) => replaceOutput.includes(record.managementToken))) {
            throw new Error('Packed CLI replace output exposed a management capability');
        }
        const replacement = JSON.parse(replaceOutput) as PublishedShare;
        expect(replacement).toMatchObject({ publicId: codex.result.publicId, publicUrl: codex.result.publicUrl, source: 'codex' });
        await page.goto(anonymousViewerUrl(codex.result.publicId), { waitUntil: 'domcontentloaded', timeout: 180_000 });
        await expectReadOnlyTranscript(page);
        await expectMessageText(page, 'agent', 'The updated illustration is ready on the same public link.');
        await expect(page.getByText('The illustration is ready and keeps the same aspect ratio.', { exact: true })).toHaveCount(0);
        await pauseForEvidence(page);
        await page.screenshot({ path: evidencePath(testInfo, 'codex-replaced-public-snapshot.png'), fullPage: true });

        await page.goto(anonymousViewerUrl(claude.result.publicId), { waitUntil: 'domcontentloaded', timeout: 180_000 });
        await expectReadOnlyTranscript(page);
        await expect(page.getByTestId('public-session-source-label')).toHaveText('Claude Code');
        await expectMessageText(page, 'user', 'Review this Paws sharing illustration.');
        await expectMessageText(page, 'agent', 'The illustration is ready to share.');
        const claudeWork = page.getByTestId('conversation-agent-work-toggle').first();
        await expect(claudeWork).toBeVisible();
        await expect(page.getByTestId('conversation-tool-group-toggle')).toHaveCount(0);
        await pauseForEvidence(page);
        await claudeWork.click();
        await expect(page.getByTestId('conversation-tool-group-toggle').first()).toBeVisible();
        await pauseForEvidence(page);
        await page.screenshot({ path: evidencePath(testInfo, 'claude-code-public-snapshot.png'), fullPage: true });

        const revokeOutput = runCli(['revoke', codex.result.publicId, '--json']);
        if (records.records.some((record) => revokeOutput.includes(record.managementToken))) {
            throw new Error('Packed CLI revoke output exposed a management capability');
        }
        expect(JSON.parse(revokeOutput)).toEqual({ publicId: codex.result.publicId, revoked: true });

        const revokedSnapshot = await request.get(
            new URL(`/v1/public/session-shares/${encodeURIComponent(codex.result.publicId)}`, serverUrl).toString(),
        );
        expect(revokedSnapshot.status()).toBe(404);
        const revokedAttachment = await request.get(new URL(
            `/v1/public/session-shares/${encodeURIComponent(codex.result.publicId)}/attachments/${encodeURIComponent(codexAttachmentId)}`,
            serverUrl,
        ).toString());
        expect(revokedAttachment.status()).toBe(404);

        await page.goto(anonymousViewerUrl(codex.result.publicId), { waitUntil: 'domcontentloaded', timeout: 180_000 });
        await expect(page.getByTestId('public-session-share-unavailable')).toBeVisible({ timeout: 180_000 });
        await expect(page.getByText('This shared session is unavailable', { exact: true })).toBeVisible();
        if (recordEvidence) await page.waitForTimeout(3_000);
        await page.screenshot({ path: evidencePath(testInfo, 'revoked-public-snapshot.png'), fullPage: true });
    } finally {
        await page.close();
    }
});
