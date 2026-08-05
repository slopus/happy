import { expect, type Page } from '@playwright/test';

export async function installProductionRedaction(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const install = () => {
            if (document.getElementById('paws-e2e-redaction-style')) return;
            const style = document.createElement('style');
            style.id = 'paws-e2e-redaction-style';
            style.textContent = `
                [data-testid="sidebar-account-footer"] {
                    filter: blur(14px) !important;
                }
                [data-testid="session-files-sidebar"] > :not(:first-child) {
                    filter: blur(14px) !important;
                }
            `;
            document.documentElement.appendChild(style);

            const sidebarMask = document.createElement('div');
            sidebarMask.id = 'paws-e2e-sidebar-mask';
            Object.assign(sidebarMask.style, {
                position: 'fixed',
                inset: '0 auto 0 0',
                width: '0px',
                background: '#111',
                zIndex: '2147483647',
                pointerEvents: 'none',
            });
            document.documentElement.appendChild(sidebarMask);
            const updateSidebarMask = () => {
                const accountFooter = document.querySelector('[data-testid="sidebar-account-footer"]');
                if (!(accountFooter instanceof HTMLElement)) return;
                const rect = accountFooter.getBoundingClientRect();
                sidebarMask.style.width = `${Math.ceil(rect.right + rect.left)}px`;
            };
            updateSidebarMask();
            new MutationObserver(updateSidebarMask).observe(document.documentElement, {
                childList: true,
                subtree: true,
            });
            window.addEventListener('resize', updateSidebarMask);
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', install, { once: true });
        } else {
            install();
        }
    });
}

export async function expectProductionRedactionReady(page: Page): Promise<void> {
    const accountFooter = page.locator('[data-testid="sidebar-account-footer"]:visible');
    const sidebarMask = page.locator('#paws-e2e-sidebar-mask');
    await expect(accountFooter).toBeVisible();
    await expect(sidebarMask).toBeAttached();
    await expect.poll(async () => sidebarMask.evaluate((element) => (
        Number.parseFloat((element as HTMLElement).style.width || '0')
    ))).toBeGreaterThan(0);
    await expect.poll(async () => accountFooter.evaluate((element) => (
        window.getComputedStyle(element).filter
    ))).not.toBe('none');
}
