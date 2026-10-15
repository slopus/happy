import { expect, test, type Locator } from '@playwright/test';

const authenticatedWebUrl = process.env.HAPPY_E2E_WEB_URL!;

function route(pathname: string): string {
    const url = new URL(authenticatedWebUrl);
    url.pathname = pathname;
    return url.toString();
}

async function sceneTransform(svg: Locator): Promise<string> {
    return svg.evaluate(element => getComputedStyle(element.parentElement!).transform);
}

test.describe('Mermaid 图片预览与全屏查看', () => {
    test.use({ locale: 'zh-CN' });

    test('[MERMAID-PREVIEW] 桌面按正文比例紧凑预览，点击后才能缩放与拖拽', async ({ page }) => {
        test.setTimeout(180_000);
        await page.setViewportSize({ width: 1280, height: 720 });
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto(route('/settings/appearance'));
        await page.getByText('Terminal', { exact: true }).click();
        const demoUrl = new URL(route('/dev/messages-demo'));
        demoUrl.searchParams.set('demo', 'mermaid');
        await page.goto(demoUrl.toString());

        const preview = page.getByTestId('mermaid-inline-surface');
        const image = preview.locator('img');
        await expect(image).toBeVisible({ timeout: 120_000 });
        await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
        const previewBox = (await preview.boundingBox())!;
        const imageBox = (await image.boundingBox())!;
        expect(previewBox.height).toBeLessThanOrEqual(434);
        expect(imageBox.width).toBeCloseTo(previewBox.width - 2, 0);
        expect(imageBox.y).toBeCloseTo(previewBox.y + 1, 0);
        const dimensions = await image.evaluate((element: HTMLImageElement) => ({
            width: element.naturalWidth, height: element.naturalHeight,
            paddingHeight: parseFloat(getComputedStyle(element).paddingTop) + parseFloat(getComputedStyle(element).paddingBottom),
            contentTop: element.getBoundingClientRect().top + parseFloat(getComputedStyle(element).paddingTop),
        }));
        expect(Math.abs(imageBox.width - 32 - dimensions.width)).toBeLessThan(1);
        expect(previewBox.width).toBeLessThanOrEqual(dimensions.width + 35);
        expect((imageBox.height - dimensions.paddingHeight) / (imageBox.width - 32)).toBeCloseTo(dimensions.height / dimensions.width, 1);
        const badge = (await page.getByTestId('mermaid-preview-badge').boundingBox())!;
        expect(badge.y + badge.height).toBeLessThanOrEqual(dimensions.contentTop);
        await expect(preview.locator('svg')).toHaveCount(0);
        await expect(page.getByTestId('mermaid-zoom-in')).toHaveCount(0);
        const lightSource = await image.getAttribute('src');
        await page.emulateMedia({ colorScheme: 'dark' });
        await expect.poll(() => image.getAttribute('src')).not.toBe(lightSource);

        await page.getByTestId('mermaid-fullscreen-open').click();
        const fullscreen = page.getByTestId('mermaid-fullscreen-surface');
        const svg = fullscreen.locator('svg');
        await expect(svg.locator('g.node')).toHaveCount(5);
        await expect.poll(() => sceneTransform(svg)).not.toBe('none');
        const initial = await sceneTransform(svg);
        const surfaceBox = (await fullscreen.boundingBox())!;
        const svgBox = (await svg.boundingBox())!;
        expect(surfaceBox.width).toBeGreaterThan(1200);
        expect(surfaceBox.height).toBeGreaterThan(500);
        const zoomToolbar = (await page.getByTestId('mermaid-zoom-toolbar').boundingBox())!;
        expect(zoomToolbar.y).toBeGreaterThanOrEqual(surfaceBox.y + surfaceBox.height);
        await expect(page.getByTestId('mermaid-zoom-percent')).toHaveText(/\d+%/);
        await expect(page.getByTestId('mermaid-download')).toBeEnabled();
        expect(svgBox.x).toBeGreaterThanOrEqual(surfaceBox.x - 1);
        expect(svgBox.y).toBeGreaterThanOrEqual(surfaceBox.y - 1);
        expect(svgBox.x + svgBox.width).toBeLessThanOrEqual(surfaceBox.x + surfaceBox.width + 1);
        expect(svgBox.y + svgBox.height).toBeLessThanOrEqual(surfaceBox.y + surfaceBox.height + 1);

        await page.getByTestId('mermaid-zoom-in').click();
        await expect.poll(() => sceneTransform(svg)).not.toBe(initial);
        await page.getByTestId('mermaid-zoom-reset').click();
        await expect.poll(() => sceneTransform(svg)).toBe(initial);
        await page.mouse.move(640, 360);
        await page.mouse.wheel(0, -320);
        expect(await sceneTransform(svg)).toBe(initial);
        await page.keyboard.down('Control');
        await page.mouse.wheel(0, -320);
        await page.keyboard.up('Control');
        await expect.poll(() => sceneTransform(svg)).not.toBe(initial);
        await page.getByTestId('mermaid-zoom-reset').click();
        await expect.poll(() => sceneTransform(svg)).toBe(initial);
        await page.mouse.move(640, 360);
        await page.mouse.down();
        await page.mouse.move(730, 405, { steps: 8 });
        await page.mouse.up();
        await expect.poll(() => sceneTransform(svg)).not.toBe(initial);
        await page.keyboard.press('Escape');
        await expect(fullscreen).toHaveCount(0);
        await expect(image).toBeVisible();
        await page.getByTestId('mermaid-fullscreen-open').click();
        await expect(fullscreen).toBeVisible();
        await page.getByTestId('mermaid-fullscreen-close').click();
        await expect(fullscreen).toHaveCount(0);
    });
});
