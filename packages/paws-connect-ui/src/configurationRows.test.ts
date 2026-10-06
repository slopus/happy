import { afterEach, describe, expect, it, vi } from 'vitest';
import * as ui from './index';
import type { CapabilityCatalog, ServiceTarget } from '@wangjs-jacky/paws-agent/services/browser';
import type { ConfigurationRow } from './configurationRows';

const codex: ServiceTarget = { engine: 'codex', machineId: 'studio-machine', accountRef: { kind: 'codex-profile', id: 'primary' } };
const claude: ServiceTarget = { engine: 'claude', machineId: 'travel-machine', accountRef: { kind: 'device-identity', machineId: 'travel-machine', identityId: 'personal' } };
const catalog: CapabilityCatalog = {
    ...codex, protocol: 'ai-services/1', observedAt: 1791230400000, availability: 'online', completeness: 'complete',
    defaultModelId: 'native-a', execution: { permissionModes: ['chat-only', 'read-only', 'yolo'], serviceTiers: ['default', 'fast'] },
    models: [
        { id: 'native-a', name: 'Native A', supportsImages: true, serviceTiers: ['default', 'fast'], reasoning: { supportsDefault: true, values: ['low', 'high'], defaultValue: 'high' } },
        { id: 'native-b', name: 'Native B', supportsImages: false, serviceTiers: ['default'], reasoning: { supportsDefault: true, values: [], defaultValue: null } },
    ],
};
function row(id = 'summary', name = '资料摘要'): ConfigurationRow {
    return {
        id, name, value: { target: codex, modelId: null, reasoning: { mode: 'default' }, permissionMode: 'chat-only', serviceTier: 'default' },
        targets: [
            { target: codex, machineName: 'Studio Mac', accountName: 'Work account' },
            { target: claude, machineName: 'Travel Mac', accountName: 'Personal account' },
        ], catalog: structuredClone(catalog),
    };
}
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); document.body.replaceChildren(); });
function mount(rows: ConfigurationRow[] = [row()]) {
    const element = document.createElement('main'); document.body.append(element);
    const onChange = vi.fn(), onRefresh = vi.fn();
    const panel = ui.mountServiceConfigurationRows(element, { rows, onChange, onRefresh });
    cleanups.push(panel.destroy);
    return { element, panel, onChange, onRefresh };
}
function select(element: HTMLElement, label: string): HTMLSelectElement {
    const found = [...element.querySelectorAll('select')].find(el => el.getAttribute('aria-label') === label);
    expect(found, `select: ${label}`).toBeTruthy(); return found!;
}
function button(element: HTMLElement, label: string): HTMLButtonElement | undefined {
    return [...element.querySelectorAll('button')].find(el => el.getAttribute('aria-label') === label);
}
function change(el: HTMLSelectElement, value: string) { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); }

describe('shared application service rows', () => {
    it('exports the reusable row mount beside the existing service panel', () => {
        expect(ui.mountServiceConfigurationRows).toBeTypeOf('function');
        expect(ui.mountServicePanel).toBeTypeOf('function');
    });
    it('keeps each application draft independent and emits no callbacks on mount or update', () => {
        const rows = [row(), row('chat', '共学对话')];
        const { element, panel, onChange, onRefresh } = mount(rows);
        panel.update(rows);
        expect(onChange).not.toHaveBeenCalled(); expect(onRefresh).not.toHaveBeenCalled();
        change(select(element, '资料摘要 模型'), 'native-b');
        expect(onChange).toHaveBeenCalledExactlyOnceWith('summary', { modelId: 'native-b', reasoning: { mode: 'default' }, serviceTier: 'default' });
        expect(select(element, '共学对话 模型').value).toBe('');
        expect(rows[0].value.modelId).toBeNull();
        button(element, '共学对话 更新模型目录')!.click();
        expect(onRefresh).toHaveBeenCalledExactlyOnceWith('chat');
    });
    it('lists only catalog models and makes the actual native default explicit', () => {
        const { element } = mount();
        const models = select(element, '资料摘要 模型');
        expect([...models.options].map(option => option.value)).toEqual(['', 'native-a', 'native-b']);
        expect(models.selectedOptions[0].textContent).toContain('Native A');
        expect(select(element, '资料摘要 推理强度').selectedOptions[0].textContent).toContain('high');
    });
    it('resets execution choices when the user chooses another engine, account, and device', () => {
        const configured = row(); configured.value.permissionMode = 'yolo'; configured.value.serviceTier = 'fast';
        const { element, onChange } = mount([configured]);
        const targets = select(element, '资料摘要 执行设备与账号');
        expect(targets.options[1].textContent).toContain('claude');
        expect(targets.options[1].textContent).toContain('Personal account');
        expect(targets.options[1].textContent).toContain('Travel Mac');
        change(targets, targets.options[1].value);
        expect(onChange).toHaveBeenCalledExactlyOnceWith('summary', {
            target: claude, modelId: null, reasoning: { mode: 'default' }, permissionMode: 'chat-only', serviceTier: 'default',
        });
    });
    it('offers only advertised permissions and emits native reasoning choices', () => {
        const configured = row(); configured.catalog!.execution!.permissionModes = ['chat-only', 'read-only'];
        const { element, onChange } = mount([configured]);
        const permissions = select(element, '资料摘要 权限');
        expect([...permissions.options].map(option => [option.value, option.textContent])).toEqual([['chat-only', '问答'], ['read-only', '只读']]);
        change(permissions, 'read-only');
        expect(onChange).toHaveBeenLastCalledWith('summary', { permissionMode: 'read-only' });
        change(select(element, '资料摘要 推理强度'), 'low');
        expect(onChange).toHaveBeenLastCalledWith('summary', { reasoning: { mode: 'explicit', value: 'low' } });
    });
    it('requires execution and effective model support before offering Fast', () => {
        const configured = row();
        const { element, panel, onChange } = mount([configured]);
        const fast = button(element, '资料摘要 Fast')!;
        expect(fast.getAttribute('aria-pressed')).toBe('false'); fast.click();
        expect(onChange).toHaveBeenCalledExactlyOnceWith('summary', { serviceTier: 'fast' });
        configured.value.modelId = 'native-b'; panel.update([configured]);
        expect(button(element, '资料摘要 Fast')).toBeUndefined();
        configured.value.modelId = null; configured.catalog!.execution!.serviceTiers = ['default']; panel.update([configured]);
        expect(button(element, '资料摘要 Fast')).toBeUndefined();
        delete configured.catalog!.execution; panel.update([configured]);
        expect(element.querySelector('[aria-label="资料摘要 权限"]')).toBeNull();
        expect(button(element, '资料摘要 Fast')).toBeUndefined();
    });
    it('keeps stale selections visible and does not silently change the draft', () => {
        const configured = row();
        configured.value = { ...configured.value, modelId: 'retired-model', reasoning: { mode: 'explicit', value: 'ultra' }, permissionMode: 'yolo', serviceTier: 'fast' };
        configured.catalog!.execution!.permissionModes = ['chat-only'];
        const { element, panel, onChange } = mount([configured]);
        panel.update([configured]);
        for (const [label, value] of [['模型', 'retired-model'], ['推理强度', 'ultra'], ['权限', 'yolo']]) {
            const field = select(element, `资料摘要 ${label}`);
            expect(field.value).toBe(value); expect(field.selectedOptions[0].disabled).toBe(true);
            expect(field.selectedOptions[0].textContent).toContain('不可用');
        }
        expect(element.textContent).toContain('Fast 不可用');
        expect(onChange).not.toHaveBeenCalled();
    });
    it('does not apply a catalog for a different execution target', () => {
        const configured = row(); configured.value.target = claude;
        const { element, onChange } = mount([configured]);
        expect(select(element, '资料摘要 模型').disabled).toBe(true);
        expect(element.textContent).not.toContain('Native A');
        expect(element.querySelector('[aria-label="资料摘要 权限"]')).toBeNull();
        expect(button(element, '资料摘要 Fast')).toBeUndefined();
        expect(onChange).not.toHaveBeenCalled();
    });
    it('does not enable execution choices from an offline observation', () => {
        const configured = row(); configured.catalog!.availability = 'offline';
        const { element, onChange } = mount([configured]);
        const models = select(element, '资料摘要 模型');
        expect(models.disabled).toBe(true);
        expect(select(element, '资料摘要 权限').disabled).toBe(true);
        expect(button(element, '资料摘要 Fast')!.disabled).toBe(true);
        change(models, 'native-b'); button(element, '资料摘要 Fast')!.click();
        expect(onChange).not.toHaveBeenCalled();
        expect(element.textContent).toContain('执行设备离线');
        expect(select(element, '资料摘要 执行设备与账号').disabled).toBe(false);
    });
    it('does not present reasoning defaults as available when the model requires an explicit choice', () => {
        const configured = row(); configured.catalog!.models[0].reasoning = { supportsDefault: false, values: ['precise'], defaultValue: null };
        const { element, onChange } = mount([configured]);
        const reasoning = select(element, '资料摘要 推理强度');
        expect(reasoning.value).toBe(''); expect(reasoning.selectedOptions[0].disabled).toBe(true);
        expect(reasoning.selectedOptions[0].textContent).toContain('不可用');
        change(reasoning, 'precise');
        expect(onChange).toHaveBeenCalledExactlyOnceWith('summary', { reasoning: { mode: 'explicit', value: 'precise' } });
    });
    it('shows missing targets, loading, and errors without treating them as a valid ready service', () => {
        const configured = row(); configured.targets = []; configured.catalog = null; configured.loading = true;
        const { element, panel, onChange } = mount([configured]);
        const targets = select(element, '资料摘要 执行设备与账号');
        expect(targets.value).not.toBe(''); expect(targets.selectedOptions[0].disabled).toBe(true);
        expect(targets.selectedOptions[0].textContent).toContain('不可用');
        expect(select(element, '资料摘要 模型').disabled).toBe(true);
        expect(button(element, '资料摘要 更新模型目录')!.disabled).toBe(true);
        expect(element.textContent).toContain('正在读取');
        configured.loading = false; configured.error = '设备离线。请重新连接。'; panel.update([configured]);
        expect(element.querySelector('[role="alert"]')?.textContent).toBe('设备离线。请重新连接。');
        expect(onChange).not.toHaveBeenCalled();
    });
    it('preserves focus on host updates and disables callbacks from destroyed controls', () => {
        const rows = [row()]; const { element, panel, onChange, onRefresh } = mount(rows);
        select(element, '资料摘要 模型').focus(); panel.update(rows);
        expect(document.activeElement).toBe(select(element, '资料摘要 模型'));
        const model = select(element, '资料摘要 模型'), refresh = button(element, '资料摘要 更新模型目录')!;
        panel.destroy(); change(model, 'native-b'); refresh.click(); panel.update(rows);
        expect(onChange).not.toHaveBeenCalled(); expect(onRefresh).not.toHaveBeenCalled();
        expect(element.children).toHaveLength(0);
    });
});
