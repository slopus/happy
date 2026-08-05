import { defineConfig } from '@playwright/test';

const authenticatedWebUrl = process.env.HAPPY_E2E_WEB_URL;
const recordArtifacts = process.env.HAPPY_E2E_RECORD === '1';

if (!authenticatedWebUrl) {
    throw new Error('缺少 HAPPY_E2E_WEB_URL；请通过 pnpm test:e2e:web 启动测试。');
}

export default defineConfig({
    testDir: './e2e',
    fullyParallel: false,
    workers: 1,
    retries: 0,
    reporter: [
        ['line'],
        ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ],
    timeout: 60_000,
    repeatEach: Number.parseInt(process.env.HAPPY_E2E_REPEAT_EACH ?? '1', 10),
    use: {
        channel: process.env.HAPPY_E2E_BROWSER_CHANNEL ?? 'chrome',
        headless: process.env.HAPPY_E2E_HEADED !== '1',
        trace: recordArtifacts ? 'on' : 'retain-on-failure',
        screenshot: recordArtifacts ? 'on' : 'only-on-failure',
        video: recordArtifacts
            ? { mode: 'on', size: { width: 1280, height: 720 } }
            : 'retain-on-failure',
    },
});
