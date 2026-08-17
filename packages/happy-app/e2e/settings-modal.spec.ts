import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const authenticatedWebUrl = process.env.HAPPY_E2E_WEB_URL!;
const evidenceDirectory = process.env.HAPPY_SETTINGS_MODAL_EVIDENCE_DIR;

function route(pathname: string): string {
    const url = new URL(authenticatedWebUrl);
    url.pathname = pathname;
    return url.toString();
}

test('[PC SETTINGS MODAL] hides persistent desktop controls behind the modal', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(route('/settings'));

    await expect(page.getByTestId('settings-modal-panel')).toBeVisible();
    await expect(page.getByTestId('settings-modal-close')).toBeVisible();
    await expect(page.getByTestId('desktop-navigation-controls')).toHaveCount(0);
    await expect(page.getByTestId('desktop-left-panel-resize-handle')).toHaveCount(0);
    await expect(page.getByTestId('desktop-right-panel-resize-handle')).toHaveCount(0);

    if (evidenceDirectory) {
        fs.mkdirSync(evidenceDirectory, { recursive: true });
        await page.screenshot({
            path: path.join(evidenceDirectory, 'case-3-after.png'),
            fullPage: true,
        });
    }

    await expect(page.getByTestId('settings-modal-backdrop')).toBeVisible();
    await page.getByTestId('settings-modal-backdrop').click({ position: { x: 8, y: 8 } });
    await expect(page.getByTestId('settings-modal-panel')).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`${new URL(authenticatedWebUrl).origin}/?$`));
});
