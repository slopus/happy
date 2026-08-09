import { chromium, expect, test as base, type BrowserContext, type Download, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const authenticatedWebUrl = process.env.HAPPY_E2E_WEB_URL!;
const evidenceDirectory = process.env.HAPPY_GENERATED_BATCH_EVIDENCE_DIR;
const automaticDownloadOrigin = new URL(authenticatedWebUrl).origin;
const recordArtifacts = process.env.HAPPY_E2E_RECORD === '1';

const test = base.extend<{ context: BrowserContext }>({
    context: async ({}, use, testInfo) => {
        const userDataDirectory = mkdtempSync(path.join(tmpdir(), 'paws-generated-batch-download-'));
        const defaultProfileDirectory = path.join(userDataDirectory, 'Default');
        const recordingDirectory = evidenceDirectory
            ? path.join(evidenceDirectory, 'recordings')
            : testInfo.outputPath('recordings');
        const chromeTimestamp = (BigInt(Date.now()) * 1000n + 11644473600000000n).toString();
        mkdirSync(defaultProfileDirectory, { recursive: true });
        if (recordArtifacts) {
            rmSync(recordingDirectory, { recursive: true, force: true });
            mkdirSync(recordingDirectory, { recursive: true });
        }
        // Chromium's batch limiter reads this content setting from the profile.
        // This isolated harness profile allows the one-click 56-file contract;
        // it does not alter the user's Chrome profile or product behavior.
        writeFileSync(path.join(defaultProfileDirectory, 'Preferences'), JSON.stringify({
            profile: {
                content_settings: {
                    pref_version: 1,
                    exceptions: {
                        automatic_downloads: {
                            [`${automaticDownloadOrigin},*`]: {
                                last_modified: chromeTimestamp,
                                setting: 1,
                            },
                        },
                    },
                },
            },
        }));

        let context: BrowserContext;
        const recordedPages: Page[] = [];
        try {
            context = await chromium.launchPersistentContext(userDataDirectory, {
                acceptDownloads: true,
                channel: process.env.HAPPY_E2E_BROWSER_CHANNEL ?? 'chrome',
                headless: process.env.HAPPY_E2E_HEADED !== '1',
                recordVideo: recordArtifacts
                    ? { dir: recordingDirectory, size: { width: 1280, height: 720 } }
                    : undefined,
            });
            recordedPages.push(...context.pages());
            context.on('page', (page) => recordedPages.push(page));
        } catch (error) {
            rmSync(userDataDirectory, { recursive: true, force: true });
            throw error;
        }
        try {
            await use(context);
        } finally {
            let closeTimer: ReturnType<typeof setTimeout> | undefined;
            let closed = false;
            try {
                await Promise.race([
                    context.close(),
                    new Promise<never>((_, reject) => {
                        closeTimer = setTimeout(
                            () => reject(new Error('Timed out closing the isolated generated-batch Chrome context')),
                            30_000,
                        );
                    }),
                ]);
                closed = true;
            } finally {
                if (closeTimer) clearTimeout(closeTimer);
                // Do not remove a live profile when a failed Chrome process does
                // not acknowledge close; the worker owns terminating it.
                if (closed) {
                    rmSync(userDataDirectory, { recursive: true, force: true });
                    if (recordArtifacts) {
                        const appPage = [...recordedPages].reverse().find((page) => (
                            page.url().includes('/dev/messages-demo')
                        ));
                        const appVideo = appPage?.video();
                        if (!appVideo) throw new Error('Generated-batch app page did not produce a recording');
                        const appVideoPath = await appVideo.path();
                        const stableVideoPath = path.join(recordingDirectory, 'generated-image-batch-e2e.webm');
                        renameSync(appVideoPath, stableVideoPath);
                        for (const filename of readdirSync(recordingDirectory)) {
                            const recordingPath = path.join(recordingDirectory, filename);
                            if (filename.endsWith('.webm') && recordingPath !== stableVideoPath) {
                                rmSync(recordingPath, { force: true });
                            }
                        }
                    }
                }
            }
        }
    },
});

test.use({ trace: 'off', video: recordArtifacts ? 'on' : 'off' });

function authenticatedRoute(pathname: string): string {
    const url = new URL(authenticatedWebUrl);
    url.pathname = pathname;
    return url.toString();
}

function evidencePath(testInfo: TestInfo, filename: string): string {
    if (!evidenceDirectory) return testInfo.outputPath(filename);
    mkdirSync(evidenceDirectory, { recursive: true });
    return path.join(evidenceDirectory, filename);
}

async function pauseForRecordedReview(page: Page, duration = 900): Promise<void> {
    if (process.env.HAPPY_E2E_RECORD === '1') {
        await page.waitForTimeout(duration);
    }
}

async function imageRects(images: Locator): Promise<Array<{ x: number; y: number; width: number; right: number }>> {
    return images.evaluateAll((elements) => elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, right: rect.right };
    }));
}

function distinctRows(rects: Array<{ y: number }>): number[] {
    return [...new Set(rects.map((rect) => Math.round(rect.y)))];
}

test('[GENERATED-BATCH-GRID] 56 张批次逐张出现、持续显示生成进度并在手机和宽屏内换行', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(authenticatedRoute('/settings/appearance'));
    await page.getByText('Gingham', { exact: true }).click();

    await page.setViewportSize({ width: 390, height: 844 });
    const url = new URL(authenticatedRoute('/dev/messages-demo'));
    url.searchParams.set('demo', 'generated-batch');
    await page.goto(url.toString());

    await expect(page.getByTestId('dev-generated-batch-demo')).toBeVisible();
    const gallery = page.getByTestId('attachment-gallery-generated-grid');
    const grid = page.getByTestId('attachment-gallery-grid');
    const progress = page.getByTestId('attachment-gallery-progress');
    const images = grid.getByTestId('attachment-gallery-image');
    const placeholders = grid.getByTestId('attachment-gallery-placeholder');
    const addImage = page.getByTestId('dev-generated-batch-add-image');
    const downloadAll = page.getByTestId('attachment-gallery-download-all');

    await expect(gallery).toHaveCount(1);
    await expect(grid).toBeVisible();
    await expect(progress).toHaveText('Generating 1/56');
    await expect(images).toHaveCount(1);
    await expect(placeholders).toHaveCount(2);
    await expect(downloadAll).toBeDisabled();
    await expect(downloadAll).toContainText('1/56');
    await expect(gallery.getByTestId('attachment-gallery-error')).toHaveCount(0);
    await expect(page.getByTestId('attachment-gallery-compact')).toHaveCount(0);
    await pauseForRecordedReview(page, 1_100);
    await page.screenshot({
        path: evidencePath(testInfo, 'generated-batch-01-mobile-1-of-56.png'),
        fullPage: true,
    });

    for (let expectedCount = 2; expectedCount <= 7; expectedCount++) {
        await addImage.click();
        await expect(images).toHaveCount(expectedCount);
        await expect(gallery.getByTestId('attachment-gallery-error')).toHaveCount(0);
        await expect(progress).toHaveText(`Generating ${expectedCount}/56`);
        await expect(page.getByTestId('dev-generated-batch-count')).toContainText(`${expectedCount}/56`);
        await pauseForRecordedReview(page, expectedCount === 2 ? 850 : 180);
    }

    const mobileRects = await imageRects(images);
    const mobileRows = distinctRows(mobileRects);
    const mobileGridBox = await grid.boundingBox();
    if (!mobileGridBox) throw new Error('找不到手机生成图网格');
    expect(mobileRows).toHaveLength(3);
    expect(mobileRects.every((rect) => rect.x >= mobileGridBox.x - 0.5 && rect.right <= mobileGridBox.x + mobileGridBox.width + 0.5)).toBe(true);
    expect(mobileRects.every((rect) => Math.abs(rect.width - mobileRects[0].width) <= 1)).toBe(true);
    expect(await grid.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

    await pauseForRecordedReview(page, 1_100);
    await page.screenshot({
        path: evidencePath(testInfo, 'generated-batch-02-mobile-7-of-56.png'),
        fullPage: true,
    });

    await page.setViewportSize({ width: 1280, height: 720 });
    await expect.poll(async () => distinctRows(await imageRects(images)).length).toBeLessThan(mobileRows.length);
    const desktopRects = await imageRects(images);
    const firstDesktopRowCount = desktopRects.filter((rect) => Math.abs(rect.y - desktopRects[0].y) <= 1).length;
    const desktopGridBox = await grid.boundingBox();
    if (!desktopGridBox) throw new Error('找不到宽屏生成图网格');
    expect(firstDesktopRowCount).toBeGreaterThan(3);
    expect(desktopRects.every((rect) => rect.x >= desktopGridBox.x - 0.5 && rect.right <= desktopGridBox.x + desktopGridBox.width + 0.5)).toBe(true);
    expect(await grid.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await expect(progress).toHaveText('Generating 7/56');
    await pauseForRecordedReview(page, 1_100);
    await page.screenshot({
        path: evidencePath(testInfo, 'generated-batch-03-desktop-7-of-56.png'),
        fullPage: true,
    });

    await addImage.click({ clickCount: 49, delay: 5 });
    await expect(images).toHaveCount(56);
    await expect(page.getByTestId('dev-generated-batch-count')).toContainText('56/56');
    await expect(progress).toHaveCount(0);
    await expect(placeholders).toHaveCount(0);
    await expect(addImage).toBeDisabled();
    await expect(gallery).toHaveCount(1);
    const completedRects = await imageRects(images);
    const completedGridBox = await grid.boundingBox();
    if (!completedGridBox) throw new Error('找不到完成态生成图网格');
    expect(completedRects.every((rect) => rect.x >= completedGridBox.x - 0.5 && rect.right <= completedGridBox.x + completedGridBox.width + 0.5)).toBe(true);
    expect(await grid.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

    const downloads: Download[] = [];
    const cdp = await page.context().newCDPSession(page);
    let browserDownloadEvents = 0;
    const browserDownloadDirectory = evidencePath(testInfo, 'browser-downloads');
    rmSync(browserDownloadDirectory, { recursive: true, force: true });
    mkdirSync(browserDownloadDirectory, { recursive: true });
    await cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allowAndName',
        downloadPath: browserDownloadDirectory,
        eventsEnabled: true,
    });
    cdp.on('Browser.downloadWillBegin', () => {
        browserDownloadEvents += 1;
    });
    page.on('download', (download) => {
        downloads.push(download);
    });

    await expect(downloadAll).toBeEnabled();
    const restingDownloadBackground = await downloadAll.evaluate((element) => (
        window.getComputedStyle(element).backgroundColor
    ));
    await downloadAll.hover();
    await expect.poll(() => downloadAll.evaluate((element) => (
        window.getComputedStyle(element).backgroundColor
    ))).not.toBe(restingDownloadBackground);
    const hoveredDownloadBackground = await downloadAll.evaluate((element) => (
        window.getComputedStyle(element).backgroundColor
    ));
    const downloadStartedAt = Date.now();
    console.log(JSON.stringify({ phase: 'before-download', browserDownloadEvents, downloadEvents: downloads.length }));
    await downloadAll.click();
    await expect(page.getByTestId('attachment-gallery-download-progress')).toBeVisible();
    await expect.poll(() => ({
        browserDownloadEvents,
        downloadEvents: downloads.length,
    }), { timeout: 60_000 }).toEqual({
        browserDownloadEvents: 56,
        downloadEvents: 56,
    });
    console.log(JSON.stringify({ phase: 'events-observed', browserDownloadEvents, downloadEvents: downloads.length }));
    await expect(page.getByTestId('attachment-gallery-download-success')).toContainText('56');
    expect(browserDownloadEvents).toBe(56);
    expect(downloads).toHaveLength(56);

    const downloadPaths = await Promise.all(downloads.map((download) => download.path()));
    await cdp.detach();
    expect(downloadPaths).toHaveLength(56);
    expect(downloadPaths.every((downloadPath) => downloadPath !== null)).toBe(true);
    const suggestedFilenames = downloads.map((download) => download.suggestedFilename());
    const expectedFilenames = Array.from({ length: 56 }, (_, index) => {
        const ordinal = String(index + 1).padStart(2, '0');
        return `${ordinal}-generated-${ordinal}.png`;
    });
    expect(suggestedFilenames).toEqual(expectedFilenames);
    const downloadedContents = readdirSync(browserDownloadDirectory)
        .map((filename) => readFileSync(path.join(browserDownloadDirectory, filename)));
    expect(downloadedContents).toHaveLength(56);
    expect(downloadedContents.map((content) => content.byteLength)).toEqual(
        Array.from({ length: 56 }, () => 68),
    );
    expect(downloadedContents.map((content) => createHash('sha256')
        .update(content)
        .digest('hex'))).toEqual(
        Array.from({ length: 56 }, () => '431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460'),
    );
    console.log(JSON.stringify({
        phase: 'downloads-complete',
        browserDownloadEvents,
        downloadEvents: downloads.length,
        completedDownloads: downloadPaths.length,
        uniqueFilenames: new Set(suggestedFilenames).size,
        elapsedMs: Date.now() - downloadStartedAt,
    }));
    await downloadAll.hover();
    await expect.poll(() => downloadAll.evaluate((element) => (
        window.getComputedStyle(element).backgroundColor
    ))).toBe(hoveredDownloadBackground);
    await pauseForRecordedReview(page, 1_100);
    await page.screenshot({
        path: evidencePath(testInfo, 'generated-batch-04-desktop-56-of-56.png'),
        fullPage: true,
    });
});
