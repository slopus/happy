import { expect, test as setup } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const keyPath = process.env.HAPPY_E2E_PRODUCTION_KEY_PATH;
const authStatePath = path.resolve('test-results/.auth/production.json');

setup('通过生产密钥建立独立登录态', async ({ page, context }) => {
    if (!keyPath) {
        throw new Error('缺少 HAPPY_E2E_PRODUCTION_KEY_PATH。');
    }

    const secretKey = (await fs.readFile(keyPath, 'utf8')).trim();
    if (!secretKey) {
        throw new Error('生产测试密钥文件为空。');
    }

    // 登录准备项目明确关闭截图、录屏和 trace；密钥只存在于该局部变量及输入框中。
    console.log('[production-auth] 打开恢复页');
    await page.goto('/restore', { waitUntil: 'domcontentloaded' });
    console.log('[production-auth] 打开密钥恢复表单');
    await page.getByText('Restore with Secret Key Instead', { exact: true }).click({ noWaitAfter: true });
    await expect(page).toHaveURL(/\/restore\/manual$/);
    console.log('[production-auth] 填写本地密钥（内容不输出）');
    await page.getByPlaceholder('XXXXX-XXXXX-XXXXX...').fill(secretKey);
    console.log('[production-auth] 提交恢复');
    const restoreButtonText = page.getByText(/^(恢复账户|恢复账号|Restore Account)$/, { exact: true });
    // Locator.click 会自动等待这个异步 action 最终触发的 router 导航，
    // 反而把测试卡回 syncCreate 的长等待。延迟触发同一 DOM click，
    // 保证 evaluate 的 CDP 响应先返回，再由受保护页面作为最终成功判据。
    await restoreButtonText.evaluate((element) => {
        window.setTimeout(() => (element as HTMLElement).click(), 5_000);
    });

    // TokenStorage 在同步引擎启动前完成持久化。生产账号历史较多时，
    // syncCreate 的完整 settings/profile/purchases 等待会让恢复页长期停留；
    // 重新加载后走 syncRestore，可立即使用已经持久化的真实登录态。
    // 使用 Node 侧计时，不依赖正在执行首次全量同步的浏览器主线程。
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    console.log('[production-auth] 登录凭据已提交，重新加载验收受保护页面');
    // 关闭正在执行首次全量同步的 renderer，新页面将从持久化凭据走 syncRestore。
    await page.close({ runBeforeUnload: false });
    const restoredPage = await context.newPage();
    await restoredPage.goto('/new', { waitUntil: 'domcontentloaded' });
    await expect(restoredPage.locator('[data-testid="new-session-message-input"]:visible')).toBeVisible({ timeout: 90_000 });

    await fs.mkdir(path.dirname(authStatePath), { recursive: true });
    await context.storageState({ path: authStatePath, indexedDB: true });
    console.log('[production-auth] 独立登录态已保存');
});
