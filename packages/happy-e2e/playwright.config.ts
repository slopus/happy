import { defineConfig, devices } from '@playwright/test';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// Read PGLITE_DIR written by globalSetup. Falls back to a stable temp path
// when running locally without globalSetup having run yet.
function getPgliteDir(): string {
    const sideChannel = path.join(__dirname, '.pglite-dir');
    if (fs.existsSync(sideChannel)) {
        return fs.readFileSync(sideChannel, 'utf-8').trim();
    }
    return process.env.PGLITE_DIR ?? path.join(os.tmpdir(), 'happy-e2e-dev');
}

const pgliteDir = getPgliteDir();
const serverDir = path.resolve(__dirname, '../../packages/happy-server');
const appDir = path.resolve(__dirname, '../../packages/happy-app');

const TEST_SECRET = 'happy-e2e-test-secret-do-not-use-in-prod';
const SERVER_PORT = parseInt(process.env.E2E_SERVER_PORT ?? '3005', 10);
const APP_PORT = parseInt(process.env.E2E_APP_PORT ?? '8081', 10);

export const SERVER_URL = `http://localhost:${SERVER_PORT}`;
export const APP_URL = `http://localhost:${APP_PORT}`;

export default defineConfig({
    testDir: './tests',
    timeout: 60_000,
    retries: process.env.CI ? 1 : 0,
    workers: 1, // both servers are shared singletons

    globalSetup: './globalSetup.ts',

    reporter: [
        ['list'],
        ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ],

    use: {
        baseURL: APP_URL,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        headless: true,
    },

    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],

    webServer: [
        {
            // Standalone server: migrate DB then start HTTP server.
            // PGlite (embedded postgres) — no Docker required.
            command: [
                `PGLITE_DIR="${pgliteDir}"`,
                `HANDY_MASTER_SECRET="${TEST_SECRET}"`,
                `PORT=${SERVER_PORT}`,
                `DB_PROVIDER=pglite`,
                `METRICS_ENABLED=false`,
                `pnpm exec tsx ./sources/standalone.ts migrate`,
                `&&`,
                `PGLITE_DIR="${pgliteDir}"`,
                `HANDY_MASTER_SECRET="${TEST_SECRET}"`,
                `PORT=${SERVER_PORT}`,
                `DB_PROVIDER=pglite`,
                `METRICS_ENABLED=false`,
                `pnpm exec tsx ./sources/standalone.ts serve`,
            ].join(' '),
            cwd: serverDir,
            url: SERVER_URL,
            reuseExistingServer: !process.env.CI,
            timeout: 30_000,
        },
        {
            // Expo web dev server. EXPO_PUBLIC_HAPPY_SERVER_URL is baked in
            // at bundle time by Metro — must be set before the process starts.
            command: [
                `EXPO_PUBLIC_HAPPY_SERVER_URL=${SERVER_URL}`,
                `APP_ENV=development`,
                `CI=1 pnpm exec expo start --web --port ${APP_PORT} --max-workers 2`,
            ].join(' '),
            cwd: appDir,
            url: APP_URL,
            reuseExistingServer: !process.env.CI,
            timeout: 180_000, // Metro cold bundle can take 2-4 min on CI
        },
    ],
});
