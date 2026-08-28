import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const authenticatedWebUrl = process.env.HAPPY_E2E_WEB_URL!;
const evidenceDirectory = process.env.HAPPY_MERMAID_EVIDENCE_DIR;
const recordEvidence = process.env.HAPPY_E2E_RECORD === '1';

function authenticatedRoute(pathname: string): string {
    const url = new URL(authenticatedWebUrl);
    url.pathname = pathname;
    return url.toString();
}

function mermaidRoute(): string {
    const url = new URL(authenticatedRoute('/dev/messages-demo'));
    url.searchParams.set('demo', 'mermaid');
    return url.toString();
}

function evidencePath(testInfo: TestInfo, filename: string): string {
    if (!evidenceDirectory) return testInfo.outputPath(filename);
    fs.mkdirSync(evidenceDirectory, { recursive: true });
    return path.join(evidenceDirectory, filename);
}

async function waitForDiagram(page: Page, surface: Locator): Promise<Locator> {
    const svg = surface.locator('svg');
    await expect(svg).toBeVisible({ timeout: 120_000 });
    await expect(svg.locator('g.node')).toHaveCount(5);
    return svg;
}

async function sceneTransform(svg: Locator): Promise<string> {
    return svg.evaluate((element) => {
        const scene = element.parentElement;
        if (!scene) throw new Error('Mermaid scene is missing.');
        return getComputedStyle(scene).transform;
    });
}

async function diagramColors(surface: Locator): Promise<{ node: string; surface: string }> {
    return {
        surface: await surface.evaluate((element) => getComputedStyle(element).backgroundColor),
        node: await surface.locator('g.node rect, g.node polygon').first().evaluate(
            (element) => getComputedStyle(element).fill,
        ),
    };
}

async function pauseForEvidence(page: Page): Promise<void> {
    if (recordEvidence) await page.waitForTimeout(900);
}

async function waitForTransformToSettle(svg: Locator): Promise<string> {
    let previous = '';
    await expect.poll(async () => {
        const current = await sceneTransform(svg);
        const settled = current === previous;
        previous = current;
        return settled;
    }).toBe(true);
    return sceneTransform(svg);
}

test.describe('Mermaid 跨端交互画布', () => {
    test.use({ locale: 'zh-CN' });

    test('[MERMAID-CANVAS] 跟随主题并支持缩放、拖拽与全屏', async ({ page }, testInfo) => {
        test.setTimeout(300_000);
        await page.setViewportSize({ width: 1280, height: 720 });
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto(authenticatedRoute('/settings/appearance'));
        await page.getByText('Terminal', { exact: true }).click();
        await page.goto(mermaidRoute());

        const inlineSurface = page.getByTestId('mermaid-inline-surface');
        await expect(inlineSurface).toBeVisible();
        const inlineSvg = await waitForDiagram(page, inlineSurface);
        const lightColors = await diagramColors(inlineSurface);
        await page.screenshot({ path: evidencePath(testInfo, 'mermaid-light-inline.png') });
        await pauseForEvidence(page);

        const initialTransform = await sceneTransform(inlineSvg);
        await page.getByTestId('mermaid-zoom-in').click();
        await expect.poll(() => sceneTransform(inlineSvg)).not.toBe(initialTransform);

        await page.getByTestId('mermaid-zoom-reset').click();
        await expect.poll(() => sceneTransform(inlineSvg)).toBe(initialTransform);

        const viewport = inlineSvg.locator('xpath=../..');
        const viewportBox = await viewport.boundingBox();
        if (!viewportBox) throw new Error('Mermaid viewport is not visible.');
        await page.mouse.move(viewportBox.x + viewportBox.width / 2, viewportBox.y + viewportBox.height / 2);
        await page.mouse.wheel(0, -320);
        await expect.poll(() => sceneTransform(inlineSvg)).not.toBe(initialTransform);

        await page.getByTestId('mermaid-zoom-reset').click();
        await expect.poll(() => sceneTransform(inlineSvg)).toBe(initialTransform);
        await page.getByTestId('mermaid-zoom-in').click();
        await expect.poll(() => sceneTransform(inlineSvg)).not.toBe(initialTransform);
        const dragStartTransform = await waitForTransformToSettle(inlineSvg);
        const inlineSvgBox = await inlineSvg.boundingBox();
        if (!inlineSvgBox) throw new Error('Mermaid SVG is not visible.');
        const startX = inlineSvgBox.x + inlineSvgBox.width / 2;
        const startY = inlineSvgBox.y + inlineSvgBox.height / 2;
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(startX + 90, startY + 45, { steps: 8 });
        await page.mouse.up();
        await expect.poll(() => sceneTransform(inlineSvg)).not.toBe(dragStartTransform);

        await page.emulateMedia({ colorScheme: 'dark' });
        await expect.poll(async () => diagramColors(inlineSurface)).not.toEqual(lightColors);
        const darkColors = await diagramColors(inlineSurface);
        expect(darkColors.surface).not.toBe(lightColors.surface);
        expect(darkColors.node).not.toBe(lightColors.node);
        await pauseForEvidence(page);

        await page.getByTestId('mermaid-fullscreen-open').click();
        const fullscreenSurface = page.getByTestId('mermaid-fullscreen-surface');
        await expect(fullscreenSurface).toBeVisible();
        const fullscreenSvg = await waitForDiagram(page, fullscreenSurface);
        await expect.poll(async () => {
            const surfaceBox = await fullscreenSurface.boundingBox();
            const svgBox = await fullscreenSvg.boundingBox();
            if (!surfaceBox || !svgBox) return false;
            return svgBox.x >= surfaceBox.x
                && svgBox.y >= surfaceBox.y
                && svgBox.x + svgBox.width <= surfaceBox.x + surfaceBox.width
                && svgBox.y + svgBox.height <= surfaceBox.y + surfaceBox.height;
        }).toBe(true);
        const fullscreenBox = await fullscreenSurface.boundingBox();
        const fullscreenSvgBox = await fullscreenSvg.boundingBox();
        expect(fullscreenBox?.width).toBeGreaterThan(1200);
        expect(fullscreenBox?.height).toBeGreaterThan(650);
        if (!fullscreenBox || !fullscreenSvgBox) throw new Error('Fullscreen diagram geometry is missing.');
        expect(fullscreenSvgBox.x).toBeGreaterThanOrEqual(fullscreenBox.x);
        expect(fullscreenSvgBox.y).toBeGreaterThanOrEqual(fullscreenBox.y);
        expect(fullscreenSvgBox.x + fullscreenSvgBox.width).toBeLessThanOrEqual(fullscreenBox.x + fullscreenBox.width);
        expect(fullscreenSvgBox.y + fullscreenSvgBox.height).toBeLessThanOrEqual(fullscreenBox.y + fullscreenBox.height);
        await pauseForEvidence(page);
        await page.screenshot({ path: evidencePath(testInfo, 'mermaid-dark-fullscreen.png') });

        await page.getByTestId('mermaid-fullscreen-close').click();
        await expect(fullscreenSurface).toHaveCount(0);
        await expect(inlineSurface).toBeVisible();
    });
});
