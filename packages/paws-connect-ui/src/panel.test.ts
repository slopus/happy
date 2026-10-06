import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountServicePanel, type ServicePanelAppearance } from './panel';
import { createSyntheticController, syntheticCatalog } from '../examples/synthetic';
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()); document.body.replaceChildren(); });
async function mounted(prepare?: (fixture: ReturnType<typeof createSyntheticController>) => Promise<void>, appearance: ServicePanelAppearance = {}) {
    const f = createSyntheticController();
    await prepare?.(f);
    const subscribe = f.controller.subscribe;
    let subscriptions = 0;
    f.controller.subscribe = listener => {
        subscriptions++;
        const unsubscribe = subscribe(listener);
        return () => { subscriptions--; unsubscribe(); };
    };
    cleanups.push(() => f.controller.dispose());
    const root = document.createElement('main'); document.body.append(root);
    const panel = mountServicePanel(root, { controller: f.controller, appearance: { ownerManagementUrl: 'https://example.invalid/manage', ...appearance } });
    cleanups.push(panel.destroy);
    return { ...f, root, panel, subscriptionCount: () => subscriptions };
}
function button(root: HTMLElement, text: string) {
    const found = [...root.querySelectorAll('button')].find(el => el.textContent === text);
    expect(found, `button: ${text}`).toBeTruthy(); return found!;
}
function select(root: HTMLElement, label: string) { return root.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement; }
function change(el: HTMLSelectElement, value: string) { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); }
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe('service panel using the real SDK controller', () => {
    it('shows a single default service without manual authorization controls or a nested heading', async () => {
        const { root } = await mounted(undefined, { sources: ['platform'], showTitle: false });
        expect(root.querySelector('h2')).toBeNull();
        expect(select(root, '服务来源')).toBeNull();
        expect(root.textContent).toContain('默认服务');
        expect(root.textContent).toContain('正在准备默认服务…');
        expect(root.textContent).toContain('模型：跟随服务默认配置');
        expect(root.textContent).toContain('推理强度：跟随服务默认配置');
        expect(root.querySelector('select[aria-label="模型"]')).toBeNull();
        expect([...root.querySelectorAll('button')].map(el => el.textContent)).toEqual(['调整模型', '服务详情']);
        expect(root.querySelector('a')).toBeNull();
        expect(root.textContent).not.toMatch(/授权|撤销|本地|存储/);
    });
    it('claims availability only after reading an online catalog', async () => {
        const { root, controller } = await mounted();
        await controller.connect();
        expect(root.querySelector('[role="status"] strong')?.textContent).toBe('已连接');
        expect(root.textContent).not.toContain('Catalog native default');
        await controller.refresh();
        expect(root.querySelector('[role="status"] strong')?.textContent).toBe('可用');
    });
    it('shows actual service details without grant, storage, or conversation execution fields', async () => {
        const f = await mounted(async f => {
            f.setStorageWarning('remember-unavailable');
            await f.controller.connect(); await f.controller.refresh();
        });
        expect(f.root.textContent).not.toContain('无法记住授权');
        button(f.root, '服务详情').click();
        const dialog = f.root.querySelector('[role="dialog"]');
        expect(dialog?.textContent).toContain('codex');
        expect(dialog?.textContent).toContain('demo-device');
        expect(dialog?.textContent).toContain('在线 / 完整');
        expect(dialog?.textContent).not.toMatch(/授权到期|连接存储|服务标识|实际模型|实际推理强度/);
    });
    it('reads a missing catalog once when model settings open and keeps explicit refresh recovery', async () => {
        const f = await mounted(async f => { await f.controller.connect(); });
        const refresh = vi.spyOn(f.controller, 'refresh');
        f.delayRead();
        button(f.root, '调整模型').click(); await settle();
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(select(f.root, '模型').disabled).toBe(true);
        expect(f.root.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true);
        f.finishRead(); await settle();
        expect(select(f.root, '模型').disabled).toBe(false);
        expect([...select(f.root, '模型').options].map(option => option.value)).toEqual(['', 'catalog-default', 'basic']);
        button(f.root, '关闭').click(); button(f.root, '调整模型').click(); await settle();
        expect(refresh).toHaveBeenCalledTimes(1);
        button(f.root, '更新模型目录').click(); await settle();
        expect(refresh).toHaveBeenCalledTimes(2);
    });
    it('does not read model capabilities before the service is connected', async () => {
        const f = await mounted();
        const refresh = vi.spyOn(f.controller, 'refresh');
        button(f.root, '调整模型').click(); await settle();
        expect(refresh).not.toHaveBeenCalled();
        expect(select(f.root, '模型').disabled).toBe(true);
    });
    it('restores the platform connection before reading capabilities on retry', async () => {
        const f = await mounted(async f => {
            f.setError('machine-offline'); await f.controller.connect().catch(() => {});
        });
        const restore = vi.spyOn(f.controller, 'restore');
        const refresh = vi.spyOn(f.controller, 'refresh');
        f.setError(null);
        button(f.root, '重试').click(); await settle();
        expect(restore).toHaveBeenCalledOnce();
        expect(refresh).toHaveBeenCalledOnce();
        expect(restore.mock.invocationCallOrder[0]).toBeLessThan(refresh.mock.invocationCallOrder[0]);
        expect(f.root.querySelector('[role="status"] strong')?.textContent).toBe('可用');
    });
    it('offers retry when the catalog reports an offline device', async () => {
        const f = await mounted(async f => {
            f.setCatalog({ ...syntheticCatalog, availability: 'offline' });
            await f.controller.connect(); await f.controller.refresh();
        });
        expect(f.root.querySelector('[role="status"] strong')?.textContent).toContain('执行设备离线');
        expect(f.root.querySelector('[role="status"] strong')?.textContent).not.toBe('可用');
        f.setCatalog(syntheticCatalog);
        button(f.root, '重试').click(); await settle();
        expect(f.root.querySelector('[role="status"] strong')?.textContent).toBe('可用');
    });
    it('shows preparation while reconnecting after an offline catalog', async () => {
        const f = await mounted(async f => {
            f.setCatalog({ ...syntheticCatalog, availability: 'offline' });
            await f.controller.connect(); await f.controller.refresh();
        });
        const connecting = f.controller.connect();
        expect(f.root.querySelector('[role="status"] strong')?.textContent).toBe('正在准备默认服务…');
        await connecting;
    });
    it('keeps keyboard focus after retry succeeds', async () => {
        const f = await mounted(async f => {
            f.setError('machine-offline'); await f.controller.connect().catch(() => {});
        });
        f.setError(null);
        const retry = button(f.root, '重试'); retry.focus(); retry.click(); await settle();
        expect(document.activeElement).toBe(button(f.root, '调整模型'));
    });
    it('does not refresh a different source when an old platform restore completes', async () => {
        const f = await mounted(async f => {
            f.setError('machine-offline'); await f.controller.connect().catch(() => {});
        });
        const restore = f.controller.restore;
        let release!: () => void;
        f.controller.restore = async () => {
            const connection = await restore();
            await new Promise<void>(resolve => { release = resolve; });
            return connection;
        };
        const refresh = vi.spyOn(f.controller, 'refresh');
        f.setError(null);
        button(f.root, '重试').click(); await settle();
        change(select(f.root, '服务来源'), 'personal');
        release(); await settle();
        expect(refresh).not.toHaveBeenCalled();
        expect(f.controller.getState().source).toBe('personal');
        expect(f.controller.getState().status).toBe('disconnected');
    });
    it('leaves a failed catalog read recoverable in the model dialog', async () => {
        const f = await mounted(async f => { await f.controller.connect(); });
        f.setError('resource-busy');
        button(f.root, '调整模型').click(); await settle();
        expect(f.root.querySelector('[role="dialog"] [data-error-code]')?.getAttribute('data-error-code')).toBe('resource-busy');
        f.setError(null);
        button(f.root, '更新模型目录').click(); await settle();
        expect(f.root.querySelector('[role="dialog"] [data-error-code]')).toBeNull();
        expect(select(f.root, '模型').disabled).toBe(false);
    });
    it('ignores old-source pending and capability completions without switching the payer', async () => {
        const f = await mounted();
        change(select(f.root, '服务来源'), 'personal');
        button(f.root, '连接').click(); await settle();
        expect(f.root.querySelector('svg[aria-label="授权二维码"]')).not.toBeNull();
        change(select(f.root, '服务来源'), 'platform');
        f.emitOldPending(); f.approve(); await settle();
        expect(f.root.textContent).not.toContain('在此设备授权');
        await f.controller.connect(); f.delayRead(); const read = f.controller.refresh();
        change(select(f.root, '服务来源'), 'personal');
        f.finishRead(); await read;
        expect(f.controller.getState().catalog).toBeNull();
        expect(select(f.root, '服务来源').value).toBe('personal');
    });
    it('does not start an already queued connection after the user changes source', async () => {
        const f = await mounted();
        change(select(f.root, '服务来源'), 'personal');
        button(f.root, '连接').click();
        change(select(f.root, '服务来源'), 'platform');
        await settle();
        expect(f.controller.getState().status).toBe('disconnected');
        expect(f.root.querySelector('svg')).toBeNull();
    });
    it('removes stale model and effort overrides when live capability data changes', async () => {
        const f = await mounted(); await f.controller.connect(); await f.controller.refresh();
        button(f.root, '调整模型').click();
        change(select(f.root, '模型'), 'catalog-default');
        change(select(f.root, '推理强度'), 'high');
        expect(f.controller.getState().overrides.reasoning).toEqual({ mode: 'explicit', value: 'high' });
        f.setCatalog({ ...syntheticCatalog, models: syntheticCatalog.models.slice(1), defaultModelId: 'basic' });
        await f.controller.refresh();
        expect(f.controller.getState().overrides.modelId).toBeUndefined();
        expect(f.controller.getState().overrides.reasoning).toBeUndefined();
        expect(select(f.root, '模型').value).toBe('');
    });
    it('preserves a host reasoning-only override on mount and refresh without inventing its model', async () => {
        const f = await mounted(async f => {
            await f.controller.connect(); await f.controller.refresh();
            f.controller.setOverrides({ reasoning: { mode: 'explicit', value: 'high' } });
        });
        expect(f.controller.getState().overrides).toEqual({ reasoning: { mode: 'explicit', value: 'high' } });
        expect(f.root.textContent).toContain('推理强度覆盖：high');
        button(f.root, '调整模型').click();
        expect(select(f.root, '模型').value).toBe('');
        expect(select(f.root, '推理强度').value).toBe('high');
        expect(select(f.root, '推理强度').disabled).toBe(true);
        expect(f.root.querySelector('[role="dialog"]')?.textContent).toContain('尚未验证支持情况');
        // Even a catalog default that cannot support high is not the configured service model.
        f.setCatalog({ ...syntheticCatalog, defaultModelId: 'basic' });
        await f.controller.refresh();
        expect(f.controller.getState().overrides).toEqual({ reasoning: { mode: 'explicit', value: 'high' } });
        expect(select(f.root, '推理强度').value).toBe('high');
        button(f.root, '恢复服务默认配置').click();
        expect(f.controller.getState().overrides).toEqual({});
        expect(select(f.root, '推理强度').value).toBe('');
    });
    it('offers only native model-specific parameters and rejects forged change events', async () => {
        const f = await mounted(); await f.controller.connect(); await f.controller.refresh();
        button(f.root, '调整模型').click();
        expect(select(f.root, '推理强度').disabled).toBe(true);
        change(select(f.root, '模型'), 'catalog-default');
        expect([...select(f.root, '推理强度').options].map(o => o.value)).toEqual(['', 'low', 'high']);
        const bad = document.createElement('option'); bad.value = 'extreme'; select(f.root, '推理强度').append(bad);
        change(select(f.root, '推理强度'), 'extreme');
        expect(f.controller.getState().overrides.reasoning).toBeUndefined();
        change(select(f.root, '模型'), 'basic');
        expect([...select(f.root, '推理强度').options].map(o => o.value)).toEqual(['']);
        expect(f.root.querySelector('input[name="permissions"]')).toBeNull();
    });
    it('traps dialog focus, closes with Escape, and restores the opening control', async () => {
        const f = await mounted(); const opener = button(f.root, '调整模型'); opener.focus(); opener.click();
        const close = button(f.root, '关闭'); expect(document.activeElement).toBe(close);
        close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
        expect(document.activeElement).not.toBe(opener);
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(f.root.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(opener);
    });
    it('keeps focus in the dialog during refresh and returns it to the action after completion', async () => {
        const f = await mounted(); await f.controller.connect(); await f.controller.refresh();
        button(f.root, '调整模型').click();
        const action = button(f.root, '更新模型目录'); action.focus(); f.delayRead(); action.click(); await settle();
        expect(f.root.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true);
        f.finishRead(); await settle();
        expect(document.activeElement).toBe(button(f.root, '更新模型目录'));
        const model = select(f.root, '模型'); model.focus(); change(model, 'catalog-default');
        expect(document.activeElement).toBe(select(f.root, '模型'));
    });
    it('unsubscribes on destroy without disposing the host controller or removing host children', async () => {
        const f = await mounted(); const host = document.createElement('p'); host.textContent = 'Host content'; f.root.append(host);
        expect(f.subscriptionCount()).toBe(1);
        f.panel.destroy(); await f.controller.connect();
        expect(f.subscriptionCount()).toBe(0);
        expect(f.root.textContent).toBe('Host content'); expect(f.controller.getState().status).toBe('ready');
    });
    it.each(['machine-offline', 'account-login-required', 'quota-exhausted', 'authorization-revoked', 'authorization-expired', 'protocol-incompatible'] as const)('shows %s without claiming ready or changing source', async code => {
        const f = await mounted(); f.setError(code); await f.controller.connect().catch(() => {}); await settle();
        expect(f.root.querySelector('[data-error-code]')?.getAttribute('data-error-code')).toBe(code);
        expect(f.root.textContent).not.toContain('已授权连接');
        expect(select(f.root, '服务来源').value).toBe('platform');
        expect(f.root.textContent).not.toContain('管理授权');
        button(f.root, '重试');
    });
    it('shows refresh failures inside the open advanced dialog', async () => {
        const f = await mounted(); await f.controller.connect(); await f.controller.refresh();
        button(f.root, '调整模型').click(); f.setError('resource-busy');
        button(f.root, '更新模型目录').click(); await settle();
        expect(f.root.querySelector('[role="dialog"] [data-error-code]')?.getAttribute('data-error-code')).toBe('resource-busy');
    });
    it('removes the old panel error when the host successfully reconnects', async () => {
        const f = await mounted(); f.setError('machine-offline'); await f.controller.connect().catch(() => {}); await settle();
        f.setError(null); await f.controller.connect();
        expect(f.root.querySelector('[data-error-code]')).toBeNull();
        expect(f.root.querySelector('[role="status"] strong')?.textContent).toBe('已连接');
    });
    it('keeps remote revocation separate from forget', async () => {
        const f = await mounted(); change(select(f.root, '服务来源'), 'personal');
        button(f.root, '连接').click(); await settle(); f.approve(); await settle();
        expect(f.root.textContent).toContain('已授权连接');
        expect(f.root.textContent).toContain('管理授权');
        button(f.root, '忘记此连接').click(); await settle();
        expect(f.controller.getState().connection).toBeNull(); expect(f.root.textContent).not.toContain('已撤销');
        expect(f.root.textContent).toContain('不会撤销远端授权');
    });
    it('clears personal authorization notices when the host selects the default service', async () => {
        const f = await mounted();
        f.controller.selectSource('personal');
        button(f.root, '忘记此连接').click(); await settle();
        expect(f.root.textContent).toContain('已忘记本地连接');
        f.controller.selectSource('platform');
        expect(f.root.textContent).not.toMatch(/授权|撤销|本地|存储/);
    });
    it('ignores a personal forget notice that completes after a source change', async () => {
        const f = await mounted();
        f.controller.selectSource('personal');
        const disconnect = f.controller.disconnect;
        let release!: () => void;
        f.controller.disconnect = async reason => {
            await disconnect(reason);
            await new Promise<void>(resolve => { release = resolve; });
        };
        button(f.root, '忘记此连接').click(); await settle();
        f.controller.selectSource('platform');
        release(); await settle();
        f.controller.setOverrides({});
        expect(f.root.textContent).not.toMatch(/授权|撤销|本地|存储/);
    });
    it('rejects script authorization URLs and renders untrusted names as text', async () => {
        const f = await mounted(); change(select(f.root, '服务来源'), 'personal'); button(f.root, '连接').click(); await settle();
        f.emitPending({ id: 'bad', expiresAt: Date.now() + 60000, approvalUrl: 'javascript:alert(1)', qrUrl: 'javascript:alert(1)' });
        expect(f.root.querySelector('a[href^="javascript:"]')).toBeNull();
        expect(f.root.querySelector('svg')).toBeNull();
        change(select(f.root, '服务来源'), 'platform');
        f.setCatalog({ ...syntheticCatalog, models: [{ ...syntheticCatalog.models[0], name: '<img src=x onerror=alert(1)>' }] });
        await f.controller.connect(); await f.controller.refresh(); button(f.root, '调整模型').click();
        expect(f.root.querySelector('img')).toBeNull();
        expect(select(f.root, '模型').options[1].text).toBe('<img src=x onerror=alert(1)>');
    });
});
