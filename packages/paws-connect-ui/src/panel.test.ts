import { afterEach, describe, expect, it } from 'vitest';
import { mountServicePanel } from './panel';
import { createSyntheticController, syntheticCatalog } from '../examples/synthetic';
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()); document.body.replaceChildren(); });
async function mounted() {
    const f = createSyntheticController();
    const subscribe = f.controller.subscribe;
    let subscriptions = 0;
    f.controller.subscribe = listener => {
        subscriptions++;
        const unsubscribe = subscribe(listener);
        return () => { subscriptions--; unsubscribe(); };
    };
    cleanups.push(() => f.controller.dispose());
    const root = document.createElement('main'); document.body.append(root);
    const panel = mountServicePanel(root, { controller: f.controller, appearance: { ownerManagementUrl: 'https://example.invalid/manage' } });
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
    it('shows configured defaults honestly and does not ask for models to connect', async () => {
        const { root, controller } = await mounted();
        expect(root.textContent).toContain('跟随服务默认配置');
        expect(root.querySelector('select[aria-label="模型"]')).toBeNull();
        button(root, '连接').click(); await settle();
        expect(controller.getState().status).toBe('ready');
        expect(root.textContent).toContain('已授权连接');
        expect(root.textContent).not.toContain('Catalog native default');
        expect(root.textContent).toContain('不代表执行端当前可用');
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
        button(f.root, '连接').click();
        change(select(f.root, '服务来源'), 'personal');
        await settle();
        expect(f.controller.getState().status).toBe('disconnected');
        expect(f.root.querySelector('svg')).toBeNull();
    });
    it('removes stale model and effort overrides when live capability data changes', async () => {
        const f = await mounted(); await f.controller.connect(); await f.controller.refresh();
        button(f.root, '高级设置').click();
        change(select(f.root, '模型'), 'catalog-default');
        change(select(f.root, '推理强度'), 'high');
        expect(f.controller.getState().overrides.reasoning).toEqual({ mode: 'explicit', value: 'high' });
        f.setCatalog({ ...syntheticCatalog, models: syntheticCatalog.models.slice(1), defaultModelId: 'basic' });
        await f.controller.refresh();
        expect(f.controller.getState().overrides.modelId).toBeUndefined();
        expect(f.controller.getState().overrides.reasoning).toBeUndefined();
        expect(select(f.root, '模型').value).toBe('');
    });
    it('offers only native model-specific parameters and rejects forged change events', async () => {
        const f = await mounted(); await f.controller.connect(); await f.controller.refresh();
        button(f.root, '高级设置').click();
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
        const f = await mounted(); const opener = button(f.root, '高级设置'); opener.focus(); opener.click();
        const close = button(f.root, '关闭'); expect(document.activeElement).toBe(close);
        close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
        expect(document.activeElement).not.toBe(opener);
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(f.root.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(opener);
    });
    it('keeps focus in the dialog during refresh and returns it to the action after completion', async () => {
        const f = await mounted(); await f.controller.connect(); await f.controller.refresh();
        button(f.root, '高级设置').click();
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
        const f = await mounted(); f.setError(code); button(f.root, '连接').click(); await settle();
        expect(f.root.querySelector('[data-error-code]')?.getAttribute('data-error-code')).toBe(code);
        expect(f.root.textContent).not.toContain('已授权连接');
        expect(select(f.root, '服务来源').value).toBe('platform');
        expect(f.root.textContent).toContain('管理授权');
    });
    it('shows refresh failures inside the open advanced dialog', async () => {
        const f = await mounted(); await f.controller.connect(); await f.controller.refresh();
        button(f.root, '高级设置').click(); f.setError('resource-busy');
        button(f.root, '更新模型目录').click(); await settle();
        expect(f.root.querySelector('[role="dialog"] [data-error-code]')?.getAttribute('data-error-code')).toBe('resource-busy');
    });
    it('removes the old panel error when the host successfully reconnects', async () => {
        const f = await mounted(); f.setError('machine-offline'); button(f.root, '连接').click(); await settle();
        f.setError(null); await f.controller.connect();
        expect(f.root.querySelector('[data-error-code]')).toBeNull();
        expect(f.root.textContent).toContain('已授权连接');
    });
    it('keeps remote revocation separate from forget', async () => {
        const f = await mounted(); await f.controller.connect(); button(f.root, '忘记此连接').click(); await settle();
        expect(f.controller.getState().connection).toBeNull(); expect(f.root.textContent).not.toContain('已撤销');
        expect(f.root.textContent).toContain('不会撤销远端授权');
    });
    it('rejects script authorization URLs and renders untrusted names as text', async () => {
        const f = await mounted(); change(select(f.root, '服务来源'), 'personal'); button(f.root, '连接').click(); await settle();
        f.emitPending({ id: 'bad', expiresAt: Date.now() + 60000, approvalUrl: 'javascript:alert(1)', qrUrl: 'javascript:alert(1)' });
        expect(f.root.querySelector('a[href^="javascript:"]')).toBeNull();
        expect(f.root.querySelector('svg')).toBeNull();
        change(select(f.root, '服务来源'), 'platform');
        f.setCatalog({ ...syntheticCatalog, models: [{ ...syntheticCatalog.models[0], name: '<img src=x onerror=alert(1)>' }] });
        await f.controller.connect(); await f.controller.refresh(); button(f.root, '高级设置').click();
        expect(f.root.querySelector('img')).toBeNull();
        expect(select(f.root, '模型').options[1].text).toBe('<img src=x onerror=alert(1)>');
    });
});
