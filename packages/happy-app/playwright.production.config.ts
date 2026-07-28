import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const productionWebUrl = process.env.HAPPY_E2E_PRODUCTION_WEB_URL;

if (process.env.HAPPY_E2E_PRODUCTION !== '1') {
    throw new Error('生产回归默认禁用；请通过 pnpm test:e2e:production-session 显式启动。');
}

if (!productionWebUrl) {
    throw new Error('缺少 HAPPY_E2E_PRODUCTION_WEB_URL。');
}

const authStatePath = path.resolve(__dirname, 'test-results/.auth/production.json');

export default defineConfig({
    testDir: './e2e-production',
    outputDir: 'test-results/production-session',
    fullyParallel: false,
    workers: 1,
    retries: 0,
    timeout: 8 * 60_000,
    expect: {
        timeout: 30_000,
    },
    reporter: [
        ['line'],
        ['html', { outputFolder: 'playwright-report/production-session', open: 'never' }],
    ],
    use: {
        ...devices['Desktop Chrome'],
        baseURL: productionWebUrl,
        channel: process.env.HAPPY_E2E_BROWSER_CHANNEL ?? 'chrome',
        headless: process.env.HAPPY_E2E_HEADED !== '1',
        // 生产测试地址当前使用自签名证书；真实用户浏览器已手动信任，
        // 独立 Playwright context 需要显式采用同等策略。
        ignoreHTTPSErrors: true,
        locale: 'zh-CN',
        // 原生 trace 会保留鉴权请求头。生产回归改用经过筛选的 JSON 时间线，
        // 避免把账号凭据写进制品。
        trace: 'off',
        screenshot: 'off',
        video: process.env.HAPPY_E2E_RECORD === '1'
            ? { mode: 'on', size: { width: 1280, height: 720 } }
            : 'retain-on-failure',
    },
    projects: [
        {
            name: 'production-auth',
            testMatch: /production-auth\.setup\.ts/,
            use: {
                video: 'off',
                trace: 'off',
                screenshot: 'off',
            },
        },
        {
            name: 'production-session',
            testMatch: /production-session\.spec\.ts/,
            dependencies: ['production-auth'],
            use: {
                storageState: authStatePath,
            },
        },
    ],
});
