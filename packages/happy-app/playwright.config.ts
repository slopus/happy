import { defineConfig } from '@playwright/test';

const authenticatedWebUrl = process.env.HAPPY_E2E_WEB_URL;

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
        trace: process.env.HAPPY_E2E_RECORD === '1' ? 'on' : 'retain-on-failure',
        screenshot: process.env.HAPPY_E2E_RECORD === '1' ? 'on' : 'only-on-failure',
        video: process.env.HAPPY_E2E_RECORD === '1' ? 'on' : 'retain-on-failure',
    },
});
