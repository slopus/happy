import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function verifyMermaidPreview(runtime, config) {
    const { taskSpace, cdp, pageInfo, currentTab, listTaskSpaces, useOrCreateTaskSpace } = runtime;
    const task = await taskSpace(config.taskSpaceId);
    const page = task.page('p1');
    let expected = `http://127.0.0.1:49828/?theme=${config.theme === 'light' ? 'light' : 'dark'}`;
    const verifyTarget = async () => {
        assert.equal(task.ownership, 'agent');
        assert.equal((await task.tabs()).find(tab => tab.label === 'p1')?.targetId, config.targetId);
        assert.equal(await page.url(), expected);
    };
    await verifyTarget();
    const frames = [];
    const directory = config.record ? await mkdtemp(join(tmpdir(), 'paws-mermaid-video-')) : null;
    const settle = () => page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
    const frame = async label => {
        if (!config.record) return;
        await settle();
        await verifyTarget();
        const shot = await page.cdp('Page.captureScreenshot', { format: 'jpeg', quality: 92, captureBeyondViewport: false });
        await verifyTarget();
        const path = join(directory, `frame-${String(frames.length).padStart(2, '0')}.jpg`);
        await writeFile(path, Buffer.from(shot.data, 'base64'));
        frames.push({ label, path });
        await config.onVerifiedFrame?.(label, expected);
    };
    const assertZoomLabel = async () => {
        await settle();
        await page.waitForFunction(() => {
            const svg = document.querySelector('[data-testid="mermaid-fullscreen-surface"] svg');
            return document.querySelector('[data-testid="mermaid-zoom-percent"]').textContent
                === `${Math.round(new DOMMatrix(getComputedStyle(svg.parentElement).transform).a * 100)}%`;
        });
        const state = await page.evaluate(() => {
            const svg = document.querySelector('[data-testid="mermaid-fullscreen-surface"] svg');
            return {
                label: document.querySelector('[data-testid="mermaid-zoom-percent"]').textContent,
                actual: Math.round(new DOMMatrix(getComputedStyle(svg.parentElement).transform).a * 100),
            };
        });
        assert.equal(state.label, `${state.actual}%`);
    };
    const imageReady = () => page.waitForFunction(() => {
        const surface = document.querySelector('[data-testid="mermaid-inline-surface"]');
        const img = surface?.querySelector('img');
        return img?.complete && img.naturalWidth > 0
            && (innerWidth < 768 || surface.getBoundingClientRect().width <= img.naturalWidth + 35);
    });
    const transform = () => page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="mermaid-fullscreen-surface"] svg').parentElement).transform);
    const scale = () => page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector('[data-testid="mermaid-fullscreen-surface"] svg').parentElement).transform).a);
    const waitTransform = initial => page.waitForFunction(value => {
        const svg = document.querySelector('[data-testid="mermaid-fullscreen-surface"] svg');
        return svg && getComputedStyle(svg.parentElement).transform !== value;
    }, initial);
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.goto(expected);
    await imageReady();
    const readPreview = () => page.evaluate(() => {
        const surface = document.querySelector('[data-testid="mermaid-inline-surface"]');
        const img = surface.querySelector('img');
        const probe = document.createElement('div');
        Object.assign(probe.style, { position: 'absolute', left: '-10000px', top: '0', visibility: 'hidden', pointerEvents: 'none' });
        probe.innerHTML = decodeURIComponent(img.src.slice(img.src.indexOf(',') + 1));
        document.body.append(probe);
        const svg = probe.querySelector('svg');
        const label = svg.querySelector('.nodeLabel');
        const nodeFont = parseFloat(getComputedStyle(label).fontSize);
        const naturalWidth = svg.viewBox.baseVal.width;
        probe.remove();
        return {
            box: surface.getBoundingClientRect().toJSON(),
            image: img.getBoundingClientRect().toJSON(),
            paddingHeight: parseFloat(getComputedStyle(img).paddingTop) + parseFloat(getComputedStyle(img).paddingBottom),
            imageContentTop: img.getBoundingClientRect().top + parseFloat(getComputedStyle(img).paddingTop),
            badgeBottom: surface.querySelector('[data-testid="mermaid-preview-badge"]').getBoundingClientRect().bottom,
            ratio: img.naturalHeight / img.naturalWidth,
            naturalWidth,
            renderedNodeFont: nodeFont * (img.getBoundingClientRect().width - 32) / naturalWidth,
            bodyFont: parseFloat(getComputedStyle(document.querySelector('#body-reference')).fontSize),
            viewportHeight: innerHeight,
            nextBottom: document.querySelector('#following-message').getBoundingClientRect().bottom,
            inlineSvg: surface.querySelectorAll('svg').length,
            controls: document.querySelectorAll('[data-testid="mermaid-zoom-in"]').length,
        };
    });
    const assertWidthFirstLongPreview = preview => {
        assert.ok(preview.box.height <= Math.round(preview.viewportHeight * 0.7) + 2);
        assert.ok(preview.box.height >= preview.viewportHeight * 0.65);
        assert.ok(Math.abs(preview.image.width - preview.box.width) <= 2);
        assert.ok(Math.abs(preview.image.top - preview.box.top) <= 2);
        assert.ok(Math.abs((preview.image.height - preview.paddingHeight) / (preview.image.width - 32) - preview.ratio) < 0.02);
        assert.ok(preview.badgeBottom <= preview.imageContentTop);
        assert.ok(preview.image.bottom > preview.box.bottom + 100);
    };
    const assertDesktopReadingScale = preview => {
        assert.ok(preview.box.height <= Math.min(480, Math.round(preview.viewportHeight * 0.6)) + 2);
        assert.ok(Math.abs(preview.image.width - 32 - preview.naturalWidth) < 1);
        assert.ok(Math.abs(preview.renderedNodeFont - preview.bodyFont) < 0.5);
        assert.ok(preview.box.width <= preview.naturalWidth + 35);
        assert.ok(Math.abs(preview.image.top - preview.box.top) <= 2);
        assert.ok(preview.badgeBottom <= preview.imageContentTop);
    };
    const preview = await readPreview();
    assertDesktopReadingScale(preview);
    assert.ok(preview.box.width < 600);
    assert.ok(preview.image.bottom > preview.box.bottom + 100);
    assert.ok(preview.nextBottom < 900);
    assert.equal(preview.inlineSvg, 0);
    assert.equal(preview.controls, 0);
    await frame('桌面流程图文字与正文等大，图框随内容收紧');
    await page.mouse.move(preview.box.left + preview.box.width / 2, preview.box.top + preview.box.height / 2);
    await page.mouse.wheel(0, 160);
    await page.waitForFunction(() => scrollY > 0);
    await page.mouse.wheel(0, -800);
    await page.waitForFunction(() => scrollY === 0);

    await page.focus('[data-testid="mermaid-fullscreen-open"]');
    await page.keyboard.press('Enter');
    await waitTransform('none');
    const fitted = await page.evaluate(() => {
        const svg = document.querySelector('[data-testid="mermaid-fullscreen-surface"] svg');
        const box = svg.getBoundingClientRect();
        return { box: box.toJSON(), nodes: svg.querySelectorAll('g.node').length, text: svg.textContent };
    });
    assert.equal(fitted.nodes, 11);
    assert.ok(fitted.text.includes('澄清目标') && fitted.text.includes('交付成果'));
    assert.ok(fitted.box.top >= 0 && fitted.box.bottom <= 901);
    assert.ok(fitted.box.left >= 0 && fitted.box.right <= 1441);
    const initial = await transform();
    await assertZoomLabel();
    const lightbox = await page.evaluate(() => {
        const paper = document.querySelector('[data-testid="mermaid-fullscreen-surface"]');
        const toolbar = document.querySelector('[data-testid="mermaid-zoom-toolbar"]').getBoundingClientRect();
        const actions = document.querySelector('[data-testid="mermaid-lightbox-actions"]').getBoundingClientRect();
        const box = paper.getBoundingClientRect();
        return { paper: box.toJSON(), toolbar: toolbar.toJSON(), actions: actions.toJSON(), radius: parseFloat(getComputedStyle(paper).borderRadius) };
    });
    assert.ok(lightbox.radius > 0);
    assert.ok(lightbox.actions.bottom <= lightbox.paper.top);
    assert.ok(lightbox.toolbar.top >= lightbox.paper.bottom);
    assert.ok(Math.abs((lightbox.toolbar.left + lightbox.toolbar.right - lightbox.paper.left - lightbox.paper.right) / 2) < 2);
    await frame('键盘打开全屏，整图适配视口');
    await page.mouse.move(700, 400);
    await page.mouse.wheel(0, -120);
    assert.equal(await transform(), initial);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -120);
    await page.keyboard.up('Control');
    await waitTransform(initial);
    await assertZoomLabel();
    await page.click('[data-testid="mermaid-zoom-reset"]');
    await page.waitForFunction(value => getComputedStyle(document.querySelector('[data-testid="mermaid-fullscreen-surface"] svg').parentElement).transform === value, initial);
    await page.mouse.move(720, 450);
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) await page.mouse.move(720 + i * 12, 450 + i * 8);
    await page.mouse.up();
    await waitTransform(initial);
    const beforeZoomIn = await scale();
    await page.click('[data-testid="mermaid-zoom-in"]');
    await page.click('[data-testid="mermaid-zoom-in"]');
    await page.waitForFunction(previous => new DOMMatrix(getComputedStyle(document.querySelector('[data-testid="mermaid-fullscreen-surface"] svg').parentElement).transform).a > previous, beforeZoomIn);
    await settle();
    await assertZoomLabel();
    const beforeZoomOut = await scale();
    await frame('全屏放大拖拽阅读中文节点');
    await page.click('[data-testid="mermaid-zoom-out"]');
    await page.waitForFunction(previous => new DOMMatrix(getComputedStyle(document.querySelector('[data-testid="mermaid-fullscreen-surface"] svg').parentElement).transform).a < previous, beforeZoomOut);
    await settle();
    await assertZoomLabel();
    const exportDirectory = await mkdtemp(join(tmpdir(), 'paws-mermaid-download-'));
    const downloadPromise = page.waitForEvent('download', { timeout: 10_000 });
    await page.click('[data-testid="mermaid-download"]');
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), 'paws-diagram.svg');
    const downloadPath = join(exportDirectory, 'paws-diagram.svg');
    await download.saveAs(downloadPath);
    const exported = await readFile(downloadPath, 'utf8');
    assert.ok(exported.includes('澄清目标') && exported.includes('交付成果'));
    assert.ok(exported.includes('viewBox=') && !exported.includes('transform: scale('));
    await page.click('[data-testid="mermaid-zoom-reset"]');
    await page.waitForFunction(value => getComputedStyle(document.querySelector('[data-testid="mermaid-fullscreen-surface"] svg').parentElement).transform === value, initial);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[data-testid="mermaid-fullscreen-surface"]'));
    assert.equal(await page.evaluate(() => scrollY), 0);
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'mermaid-fullscreen-open');
    await page.click('[data-testid="mermaid-fullscreen-open"]');
    await waitTransform('none');
    await page.click('[data-testid="mermaid-fullscreen-close"]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="mermaid-fullscreen-surface"]'));
    await frame('关闭返回清晰预览，聊天位置保留');

    expected = 'http://127.0.0.1:49828/?theme=light&shape=wide';
    await page.goto(expected);
    await imageReady();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const widePreview = await readPreview();
    assertDesktopReadingScale(widePreview);
    assert.ok(widePreview.box.height < 200);
    assert.ok(Math.abs(widePreview.image.bottom - widePreview.box.bottom) <= 2);
    assert.ok(widePreview.image.right > widePreview.box.right + 100);
    assert.ok(widePreview.badgeBottom <= widePreview.imageContentTop);
    await frame('横图仍保持正文阅读尺寸，超宽内容点击查看');
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    expected = 'http://127.0.0.1:49828/?theme=light';
    await page.goto(expected);
    await imageReady();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assertWidthFirstLongPreview(await readPreview());
    await page.click('[data-testid="mermaid-fullscreen-open"]');
    await waitTransform('none');
    await frame('窄屏全屏适配');
    await page.click('[data-testid="mermaid-fullscreen-close"]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="mermaid-fullscreen-surface"]'));
    await frame('窄屏关闭返回，预览不再按高度缩小');
    const result = { status: 'pass', cases: ['DESKTOP-BODY-SIZE-PREVIEW', 'PAGE-SCROLL', 'KEYBOARD-OPEN-ESCAPE', 'FULLSCREEN-FIT-ZOOM-PAN-RESET', 'LIGHTBOX-CHROME-PERCENT-DOWNLOAD', 'LIGHT-WIDE', 'LIGHT-390'], previewMetrics: { desktop: preview, wide: widePreview }, directory, frames, downloadPath };
    console.log(JSON.stringify(result));
    return result;
}
