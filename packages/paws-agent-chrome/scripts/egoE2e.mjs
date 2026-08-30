import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
import { startE2eFixtureServer } from '../test/e2eFixtureServer.mjs';

const exec = promisify(execFile);
const extensionDir = resolve('dist');
const artifactDir = resolve('test-results/paws-agent-chrome-ego-e2e');
const recording = process.env.PAWS_EGO_E2E_RECORD === '1';
const egoExecutable = '/Applications/ego lite.app/Contents/MacOS/ego lite';
const marker = 'Investigate checkout failure from Ego Lite';
const screenshotPaths = {
    installed: resolve(artifactDir, '01-extension-installed.png'),
    collapsed: resolve(artifactDir, '02-collapsed.png'),
    accountLink: resolve(artifactDir, '03-account-link.png'),
    linked: resolve(artifactDir, '04-linked.png'),
    approval: resolve(artifactDir, '05-directory-approval.png'),
    replied: resolve(artifactDir, '06-remote-reply.png'),
    safeRequest: resolve(artifactDir, '07-safe-agent-request.png'),
    restarted: resolve(artifactDir, '08-restarted-connected.png'),
};
const mp4Path = resolve(artifactDir, 'paws-ego-lite-host-e2e.mp4');
const contactSheetPath = resolve(artifactDir, 'paws-ego-lite-host-e2e-contact-sheet.png');

await access(egoExecutable, constants.X_OK);
await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });

let profileDir = null;
let fixture = null;
let runtime = null;
let browser = null;
let extensionId = null;
let browserVersion = null;

try {
    profileDir = await mkdtemp(join(tmpdir(), 'paws-ego-host-e2e-'));
    fixture = await startE2eFixtureServer(extensionDir, { injectContentScript: false });
    stage('launch isolated Ego Lite with unpacked extension');
    runtime = await launchEgo(profileDir);
    browser = runtime.browser;
    browserVersion = await browser.version();
    const firstRun = await openFirstPage(browser);
    extensionId = firstRun.extensionId;

    stage('verify real extension storage');
    assert.deepEqual(firstRun.storageKeys.sort(), ['paws-agent.chrome.config', 'paws-agent.credentials']);

    await closeRuntime(runtime);
    runtime = null;
    browser = null;

    stage('restart Ego Lite with the same profile');
    runtime = await launchEgo(profileDir);
    browser = runtime.browser;
    const restartResult = await verifyRestart(browser, extensionId);
    assert.equal(restartResult.extensionId, extensionId, 'extension identity must remain stable across restart');
    assert.deepEqual(restartResult.storageKeys.sort(), ['paws-agent.chrome.config', 'paws-agent.credentials']);

    assert.equal(fixture.state.authRequests >= 2, true, 'account link must poll for authorization');
    assert.equal(fixture.state.spawnRequests, 2, 'directory approval must retry the spawn once');
    assert.equal(fixture.state.approvedSpawnRequests, 1, 'the approved spawn must occur exactly once');
    assert.equal(fixture.state.plainPrompts.length, 1, 'the remote fixture must receive one prompt');
    assert.equal(fixture.state.requestResolutionCalls, 0, 'the host-embedded frame must not resolve Agent requests');
    const prompt = fixture.state.plainPrompts[0];
    assert.match(prompt, /Investigate checkout failure from Ego Lite/);
    assert.match(prompt, /Paws Extension E2E Fixture/);
    assert.match(prompt, /Payment failed with code 42/);
    assert.match(prompt, new RegExp(fixture.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    stage('case assertions passed');
} finally {
    stage('cleanup');
    if (runtime) await closeRuntime(runtime).catch(() => {});
    await fixture?.close().catch(() => {});
    if (profileDir) await rm(profileDir, { recursive: true, force: true });
}

let media = null;
if (recording) {
    stage('assemble and validate Ego Lite evidence video');
    media = await createEvidenceVideo(Object.values(screenshotPaths));
}

process.stdout.write(JSON.stringify({
    case: 'PAWS-EGO-LITE-HOST-01',
    status: 'pass',
    host: egoExecutable,
    browserVersion,
    extensionId,
    mode: recording ? 'real-ego-lite-staged-video' : 'real-ego-lite-host',
    assertions: [
        'unpacked extension is listed by Ego Lite',
        'content script injection comes from chrome-extension origin',
        'single injection and collapsed geometry',
        'real chrome.storage credential persistence',
        'QR account link and online machine selection',
        'directory approval retry',
        'encrypted page context and remote reply',
        'full Agent request detail rendering without an approval RPC',
        'full Ego Lite process restart reconnect',
    ],
    sideEffects: 'temporary local protocol server and disposable Ego Lite profile only',
    artifacts: { ...screenshotPaths, ...(recording ? { mp4Path, contactSheetPath } : {}) },
    media,
}, null, 2) + '\n');

async function openFirstPage(targetBrowser) {
    const context = targetBrowser.contexts()[0];
    assert(context, 'Ego Lite must expose its persistent browser context');
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.setViewportSize({ width: 1280, height: 720 });

    stage('verify extension registration');
    await page.goto('chrome://extensions/', { waitUntil: 'domcontentloaded' });
    await page.getByText('Paws Agent Bubble', { exact: true }).first().waitFor();
    await page.screenshot({ path: screenshotPaths.installed });

    stage('verify extension-owned content injection');
    await page.goto(fixture.origin, { waitUntil: 'domcontentloaded' });
    await page.locator('#issue').selectText();
    const injection = await verifyInjection(page);
    const bubble = page.frameLocator('#paws-agent-bubble-frame');
    await bubble.getByRole('button', { name: '打开 Paws Agent' }).waitFor();
    await page.screenshot({ path: screenshotPaths.collapsed });

    stage('link account through the real extension frame');
    await bubble.getByRole('button', { name: '打开 Paws Agent' }).click();
    await waitForExpandedFrame(page);
    await bubble.getByText('把这个浏览器连接到 Paws').waitFor();
    await bubble.getByLabel('Server URL').fill(fixture.origin);
    await bubble.getByRole('button', { name: '生成绑定二维码' }).click();
    await bubble.getByAltText('Paws 设备绑定二维码').waitFor({ state: 'visible' });
    await page.screenshot({ path: screenshotPaths.accountLink });
    await page.waitForTimeout(900);

    await bubble.getByText('已连接').waitFor({ timeout: 15_000 });
    await bubble.getByLabel('远端机器').selectOption('paws-e2e-machine');
    await bubble.getByLabel('远端工作目录').fill('/tmp/paws-e2e-project');
    await bubble.getByPlaceholder('告诉远端 Agent 你想做什么…').fill(marker);
    await page.screenshot({ path: screenshotPaths.linked });
    await page.waitForTimeout(900);
    await bubble.getByRole('button', { name: '发送', exact: true }).click();
    await bubble.getByText('远端目录不存在：/tmp/paws-e2e-project').waitFor();
    await page.screenshot({ path: screenshotPaths.approval });
    await page.waitForTimeout(900);
    await bubble.getByRole('button', { name: '允许创建并继续' }).click();

    stage('verify encrypted remote reply');
    await bubble.getByText('E2E fixture reply: remote session is ready.').waitFor({ timeout: 15_000 });
    await bubble.getByText(marker, { exact: false }).waitFor();
    await page.screenshot({ path: screenshotPaths.replied });
    await page.waitForTimeout(1_100);

    stage('verify high-privilege requests stay inside the trusted approval boundary');
    fixture.emitAgentRequest();
    await bubble.getByText('Agent 请求：Bash').waitFor();
    await bubble.getByText('echo paws-e2e-safe-request', { exact: false }).waitFor();
    await bubble.getByText('/tmp/paws-e2e-project', { exact: false }).waitFor();
    await bubble.getByText('请在 Paws 自有客户端中审批', { exact: false }).waitFor();
    assert.equal(await bubble.getByRole('button', { name: '允许', exact: true }).count(), 0, 'the real extension frame must not expose a request approval control');
    assert.equal(fixture.state.requestResolutionCalls, 0, 'rendering an Agent request must not send a permission RPC');
    await page.screenshot({ path: screenshotPaths.safeRequest });

    const storageKeys = await readExtensionStorageKeys(bubble);
    return { extensionId: injection.extensionId, storageKeys };
}

async function verifyRestart(targetBrowser, expectedExtensionId) {
    const context = targetBrowser.contexts()[0];
    assert(context, 'restarted Ego Lite must expose its persistent context');
    const pages = context.pages();
    const page = pages[0] ?? await context.newPage();
    for (const extraPage of pages.slice(1)) await extraPage.close().catch(() => {});
    page.setDefaultTimeout(15_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(fixture.origin, { waitUntil: 'domcontentloaded' });
    const injection = await verifyInjection(page);
    assert.equal(injection.extensionId, expectedExtensionId);

    const bubble = page.frameLocator('#paws-agent-bubble-frame');
    await bubble.getByRole('button', { name: '打开 Paws Agent' }).click();
    await waitForExpandedFrame(page);
    await bubble.getByText('已连接').waitFor({ timeout: 15_000 });
    assert.equal(await bubble.getByText('把这个浏览器连接到 Paws').count(), 0, 'stored credentials must survive a full Ego Lite restart');
    await bubble.getByLabel('远端机器').selectOption('paws-e2e-machine');
    assert.equal(await bubble.getByLabel('远端工作目录').inputValue(), '/tmp/paws-e2e-project');
    await page.screenshot({ path: screenshotPaths.restarted });
    await page.waitForTimeout(2_000);
    return { extensionId: injection.extensionId, storageKeys: await readExtensionStorageKeys(bubble) };
}

async function verifyInjection(page) {
    const host = page.locator('iframe[data-paws-agent-bubble="true"]');
    await host.waitFor({ state: 'visible', timeout: 15_000 });
    assert.equal(await host.count(), 1, 'Ego Lite must inject exactly one bubble');
    assert.equal(await host.evaluate(frame => frame.style.width), '76px');
    const src = await host.getAttribute('src');
    assert(src, 'extension iframe must have a source URL');
    const parsed = new URL(src);
    assert.equal(parsed.protocol, 'chrome-extension:', 'the fixture page must not self-inject the panel');
    return { extensionId: parsed.hostname };
}

async function readExtensionStorageKeys(bubble) {
    return await bubble.locator('body').evaluate(async () => Object.keys(await chrome.storage.local.get(null)));
}

async function launchEgo(profile) {
    await rm(join(profile, 'DevToolsActivePort'), { force: true });
    let stderr = '';
    const child = spawn(egoExecutable, [
        `--user-data-dir=${profile}`,
        '--remote-debugging-port=0',
        `--load-extension=${extensionDir}`,
        `--disable-extensions-except=${extensionDir}`,
        '--window-size=1280,800',
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank',
    ], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-20_000); });

    let connectedBrowser = null;
    try {
        let port = null;
        for (let attempt = 0; attempt < 120; attempt += 1) {
            try {
                const [value] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
                port = Number(value);
                if (Number.isInteger(port) && port > 0) break;
            } catch {}
            if (child.exitCode !== null) throw new Error(`Ego Lite exited before CDP was ready:\n${stderr}`);
            await delay(250);
        }
        if (!port) throw new Error(`Ego Lite CDP did not become ready:\n${stderr}`);

        for (let attempt = 0; attempt < 40; attempt += 1) {
            try {
                connectedBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
                break;
            } catch {
                await delay(250);
            }
        }
        if (!connectedBrowser) throw new Error(`Could not connect to Ego Lite CDP on port ${port}`);
        return { browser: connectedBrowser, child, stderr: () => stderr };
    } catch (error) {
        await withTimeout(connectedBrowser?.close(), 4_000).catch(() => {});
        await stopChild(child);
        throw error;
    }
}

async function closeRuntime(targetRuntime) {
    await withTimeout(targetRuntime.browser.close(), 4_000).catch(() => {});
    await stopChild(targetRuntime.child);
}

async function stopChild(child) {
    if (child.exitCode !== null) return;
    const exited = new Promise(resolveExit => child.once('exit', resolveExit));
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    const stopped = await Promise.race([exited.then(() => true), delay(3_000).then(() => false)]);
    if (!stopped) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
        await Promise.race([exited, delay(2_000)]);
    }
}

async function createEvidenceVideo(paths) {
    const concatPath = resolve(artifactDir, 'frames.txt');
    const lines = [];
    for (const path of paths) {
        lines.push(`file '${path.replaceAll("'", "'\\''")}'`, 'duration 1.4');
    }
    lines.push(`file '${paths.at(-1).replaceAll("'", "'\\''")}'`);
    await writeFile(concatPath, lines.join('\n') + '\n');
    await exec('/opt/homebrew/bin/ffmpeg', [
        '-y', '-f', 'concat', '-safe', '0', '-i', concatPath,
        '-vf', 'fps=25,format=yuv420p', '-c:v', 'libx264', '-crf', '20', '-movflags', '+faststart', '-an',
        mp4Path,
    ]);
    await exec('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-i', mp4Path, '-f', 'null', '-']);
    const probe = await exec('/opt/homebrew/bin/ffprobe', [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name,pix_fmt,width,height,r_frame_rate:format=duration,size',
        '-of', 'json', mp4Path,
    ]);
    const media = JSON.parse(probe.stdout);
    const stream = media.streams?.[0];
    assert.equal(stream?.codec_name, 'h264');
    assert.equal(stream?.pix_fmt, 'yuv420p');
    assert.equal(stream?.width, 1280);
    assert.equal(stream?.height, 720);
    await exec('/opt/homebrew/bin/ffmpeg', [
        '-y', '-i', mp4Path,
        '-vf', 'fps=1/1.4,scale=320:-1,tile=4x2:padding=4:margin=4', '-frames:v', '1',
        contactSheetPath,
    ]);
    await rm(concatPath, { force: true });
    return media;
}

async function waitForExpandedFrame(page) {
    await page.waitForFunction(() => {
        const frame = document.querySelector('iframe[data-paws-agent-bubble="true"]');
        if (!frame) return false;
        const style = getComputedStyle(frame);
        return Number.parseFloat(style.width) >= 389 && Number.parseFloat(style.height) >= 639;
    });
}

function stage(label) {
    process.stderr.write(`[PAWS-EGO-LITE-HOST-01] ${label}\n`);
}

function delay(ms) {
    return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

function withTimeout(promise, timeoutMs) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`operation timed out after ${timeoutMs}ms`)), timeoutMs)),
    ]);
}
