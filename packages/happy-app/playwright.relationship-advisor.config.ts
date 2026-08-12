import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const productionWebUrl = process.env.HAPPY_E2E_PRODUCTION_WEB_URL;

if (process.env.HAPPY_E2E_PRODUCTION !== '1') {
    throw new Error('狗头军师生产 E2E 默认禁用；请显式设置 HAPPY_E2E_PRODUCTION=1。');
}

if (!productionWebUrl) {
    throw new Error('缺少 HAPPY_E2E_PRODUCTION_WEB_URL。');
}

const authStatePath = path.resolve(__dirname, 'test-results/.auth/production.json');

export default defineConfig({
    testDir: './e2e-production',
    outputDir: process.env.HAPPY_RELATIONSHIP_ADVISOR_TEST_RESULTS
        ?? 'test-results/relationship-advisor',
    fullyParallel: false,
    workers: 1,
    retries: 0,
    timeout: 8 * 60_000,
    expect: { timeout: 30_000 },
    reporter: [['line']],
    use: {
        ...devices['Desktop Chrome'],
        baseURL: productionWebUrl,
        channel: process.env.HAPPY_E2E_BROWSER_CHANNEL ?? 'chrome',
        headless: process.env.HAPPY_E2E_HEADED !== '1',
        ignoreHTTPSErrors: true,
        locale: 'zh-CN',
        actionTimeout: 30_000,
        navigationTimeout: 90_000,
        viewport: { width: 390, height: 844 },
        trace: 'off',
        screenshot: 'off',
        video: process.env.HAPPY_E2E_RECORD === '1'
            ? { mode: 'on', size: { width: 390, height: 844 } }
            : 'off',
    },
    projects: [
        {
            name: 'production-auth',
            testMatch: /production-auth\.setup\.ts/,
            use: { video: 'off', trace: 'off', screenshot: 'off' },
        },
        {
            name: 'relationship-advisor',
            testMatch: /relationship-advisor\.spec\.ts/,
            dependencies: ['production-auth'],
            use: { storageState: authStatePath },
        },
    ],
});
