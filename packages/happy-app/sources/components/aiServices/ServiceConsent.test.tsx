import * as React from 'react';
import type { ServiceGrantScope } from '@slopus/happy-wire';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { render as renderBase, press, snapshot, worker, account, catalog } from './testSupport';
import { ServiceConsent } from './ServiceConsent';
vi.mock('@/text', async () => {
    const { zhHans } = await import('@/text/translations/zh-Hans');
    return { t: (key: string) => key.split('.').reduce((value: any, segment) => value[segment], zhHans) };
});
async function render(element: React.ReactNode) {
    const r = await renderBase(element);
    const target = r.root.findAllByProps({ testID: 'target-codex-m1-a1' })[0];
    if (target) {
        await act(async () => target.props.onPress());
        await press(r, '继续');
    }
    return r;
}
const pairing = { id: 'p1', protocol: 'ai-services/1', publicKey: 'key', expiresAt: Date.now() + 60000, app: { appId: 'advisor', name: '狗头军师', origins: ['https://advisor.example'], capabilities: ['chat', 'images'], businessPrompt: { id: 'prompt', version: '1' } } } as const;
it('prefills the service and shows the full consent scope, separate from browser storage', async () => {
    const approve = vi.fn(async (_service: unknown, _scope: Omit<ServiceGrantScope, 'serviceId'>) => {});
    const r = await render(<ServiceConsent pairing={pairing as any} workers={[worker]} accounts={[account as any]} machines={[{ id: 'm1', name: 'Mac' }]} api={{ capabilities: async () => ({ catalog }) } as any} onApprove={approve} onManage={vi.fn()} />);
    const output = JSON.stringify(r.toJSON());
    for (const text of ['狗头军师', 'Mac · Codex · Work', '不包含终端、文件系统或浏览器操作', '记住连接', '授权有效期']) expect(output).toContain(text);
    expect(r.root.findAllByProps({ testID: 'consent-tools' })).toHaveLength(0);
    await press(r, '允许连接');
    expect(approve).toHaveBeenCalledWith(snapshot.revision.config, expect.objectContaining({ targets: [{ machineId: 'm1', engine: 'codex', accountRef: snapshot.revision.config.accountRef }], permissions: ['chat'], expiresAt: null }));
    expect(JSON.stringify(approve.mock.calls[0])).not.toContain('remember');
});
it.each([1, 7, 30])('uses a limited lifetime only when the owner selects %s days', async days => {
    const approve = vi.fn();
    const r = await render(<ServiceConsent pairing={pairing as any} workers={[worker]} accounts={[account as any]} machines={[]} api={{ capabilities: async () => ({ catalog }) } as any} onApprove={approve} onManage={vi.fn()} />);
    const unlimited = r.root.findByProps({ testID: 'consent-duration-unlimited' });
    expect(unlimited.props.selected).toBe(true);
    expect(JSON.stringify(r.toJSON())).toContain('有效期：直到撤销');
    await act(async () => r.root.findByProps({ testID: `consent-duration-${days}` }).props.onPress());
    expect(JSON.stringify(r.toJSON())).toContain(`有效期：${days} 天`);
    const before = Date.now();
    await press(r, '允许连接');
    expect(approve.mock.calls[0][1].expiresAt).toBeGreaterThanOrEqual(before + days * 86400_000);
    expect(approve.mock.calls[0][1].expiresAt).toBeLessThanOrEqual(Date.now() + days * 86400_000);
    expect(approve.mock.calls[0][1].permissions).toEqual(['chat']);
});
it('keeps tool permission unchecked when the requesting application supports tools', async () => {
    const approve = vi.fn();
    const toolsPairing = { ...pairing, app: { ...pairing.app, capabilities: ['chat', 'images', 'tools'] } };
    const r = await render(<ServiceConsent pairing={toolsPairing as any} workers={[worker]} accounts={[account as any]} machines={[]} api={{ capabilities: async () => ({ catalog }) } as any} onApprove={approve} onManage={vi.fn()} />);
    const choice = r.root.findByProps({ testID: 'consent-tools' });
    expect(choice.props.role).toBe('checkbox'); expect(choice.props.selected).toBe(false);
    await press(r, '允许连接');
    expect(approve.mock.calls[0][1].permissions).toEqual(['chat']);
});
it('grants tools and images only after each permission is explicitly selected', async () => {
    const approve = vi.fn();
    const toolsPairing = { ...pairing, app: { ...pairing.app, capabilities: ['chat', 'images', 'tools'] } };
    const r = await render(<ServiceConsent pairing={toolsPairing as any} workers={[worker]} accounts={[account as any]} machines={[]} api={{ capabilities: async () => ({ catalog }) } as any} onApprove={approve} onManage={vi.fn()} />);
    await act(async () => r.root.findByProps({ testID: 'consent-tools' }).props.onPress());
    await act(async () => r.root.findByProps({ testID: 'consent-images' }).props.onPress());
    expect(JSON.stringify(r.toJSON())).not.toContain('不包含终端、文件系统或浏览器操作');
    await press(r, '允许连接');
    expect(approve.mock.calls[0][1].permissions).toEqual(['chat', 'images', 'tools']);
});
it('removes tool permission when the owner deselects it', async () => {
    const approve = vi.fn();
    const toolsPairing = { ...pairing, app: { ...pairing.app, capabilities: ['chat', 'tools'] } };
    const r = await render(<ServiceConsent pairing={toolsPairing as any} workers={[worker]} accounts={[account as any]} machines={[]} api={{ capabilities: async () => ({ catalog }) } as any} onApprove={approve} onManage={vi.fn()} />);
    await act(async () => r.root.findByProps({ testID: 'consent-tools' }).props.onPress());
    await act(async () => r.root.findByProps({ testID: 'consent-tools' }).props.onPress());
    await press(r, '允许连接');
    expect(approve.mock.calls[0][1].permissions).toEqual(['chat']);
});
it('requires a fresh tools choice when the pairing changes on the same mounted screen', async () => {
    const approve = vi.fn();
    const toolsPairing = { ...pairing, app: { ...pairing.app, capabilities: ['chat', 'tools'] } };
    const api = { capabilities: async () => ({ catalog }) };
    const props = { workers: [worker], accounts: [account as any], machines: [], api: api as any, onApprove: approve, onManage: vi.fn() };
    const r = await render(<ServiceConsent {...props} pairing={toolsPairing as any} />);
    await act(async () => r.root.findByProps({ testID: 'consent-tools' }).props.onPress());
    await act(async () => r.update(<ServiceConsent {...props} pairing={{ ...toolsPairing, id: 'p2' } as any} />));
    expect(r.root.findByProps({ testID: 'consent-tools' }).props.selected).toBe(false);
    await press(r, '允许连接');
    expect(approve.mock.calls[0][1].permissions).toEqual(['chat']);
});
it('requires fresh confirmation for image permission and never allows an expired pairing', async () => {
    const approve = vi.fn();
    const r = await render(<ServiceConsent pairing={pairing as any} workers={[worker]} accounts={[account as any]} machines={[]} api={{ capabilities: async () => ({ catalog }) } as any} onApprove={approve} onManage={vi.fn()} />);
    await act(async () => r.root.findByProps({ testID: 'consent-images' }).props.onPress());
    await press(r, '允许连接');
    expect(approve.mock.calls[0][1].permissions).toEqual(['chat', 'images']);
    await act(async () => r.update(<ServiceConsent key="expired" pairing={{ ...pairing, expiresAt: 1 } as any} workers={[worker]} accounts={[]} machines={[]} api={{ capabilities: async () => ({ catalog }) } as any} onApprove={approve} onManage={vi.fn()} />));
    expect(r.root.findAllByType('Button').find((n: any) => n.props.title === '允许连接').props.disabled).toBe(true);
});
it('adds only explicitly selected verified extra targets without asking for model or effort again', async () => {
    const approve = vi.fn(async (_service: unknown, _scope: Omit<ServiceGrantScope, 'serviceId'>) => {});
    const claude = { machineId: worker.machineId, engine: 'claude', accountRef: { kind: 'device-identity', machineId: worker.machineId, identityId: worker.serviceClaudeIdentity } };
    const capabilities = vi.fn(async (target) => ({ catalog: { ...catalog, ...target, defaultModelId: target.engine === 'claude' ? null : catalog.defaultModelId } }));
    const r = await render(<ServiceConsent pairing={pairing as any} workers={[worker]} accounts={[account as any]} machines={[]} api={{ capabilities } as any} onApprove={approve} onManage={vi.fn()} />);
    await press(r, '检查其他可用目标');
    const extra = r.root.findByProps({ testID: 'consent-target-claude-m1' });
    expect(extra.props.selected).toBe(false);
    expect(extra.props.disabled).toBe(false);
    await act(async () => extra.props.onPress());
    await press(r, '允许连接');
    expect(approve.mock.calls[0][1].targets).toEqual([{ machineId: 'm1', engine: 'codex', accountRef: snapshot.revision.config.accountRef }, claude]);
    expect(capabilities.mock.calls.map(c => c[0].engine)).toEqual(['codex', 'codex', 'claude']);
    expect(approve.mock.calls[0][1]).not.toHaveProperty('modelId');
});
it('disables offline and unsupported additional targets and keeps the current target alone by default', async () => {
    const approve = vi.fn(async (_service: unknown, _scope: Omit<ServiceGrantScope, 'serviceId'>) => {});
    const workers = [worker, { ...worker, machineId: 'm2', serviceClaudeIdentity: null }];
    const capabilities = vi.fn(async (target) => ({ catalog: { ...catalog, ...target, availability: target.machineId === 'm2' ? 'offline' : 'online', models: target.engine === 'claude' ? [] : catalog.models } }));
    const r = await render(<ServiceConsent pairing={pairing as any} workers={workers} accounts={[account as any]} machines={[]} api={{ capabilities } as any} onApprove={approve} onManage={vi.fn()} />);
    await press(r, '检查其他可用目标');
    for (const id of ['consent-target-claude-m1', 'consent-target-codex-m2-a1']) {
        const extra = r.root.findByProps({ testID: id });
        expect(extra.props.disabled).toBe(true);
        await act(async () => extra.props.onPress());
    }
    await press(r, '允许连接');
    expect(approve.mock.calls[0][1].targets).toEqual([{ machineId: 'm1', engine: 'codex', accountRef: snapshot.revision.config.accountRef }]);
});
it('lets the owner remove an extra that becomes unavailable on recheck instead of silently changing scope', async () => {
    let online = true;
    const approve = vi.fn(async (_service: unknown, _scope: Omit<ServiceGrantScope, 'serviceId'>) => {});
    const api = { capabilities: vi.fn(async (target) => ({ catalog: { ...catalog, ...target, availability: target.engine === 'claude' && !online ? 'offline' : 'online' } })) };
    const r = await render(<ServiceConsent pairing={pairing as any} workers={[worker]} accounts={[account as any]} machines={[]} api={api as any} onApprove={approve} onManage={vi.fn()} />);
    await press(r, '检查其他可用目标');
    await act(async () => r.root.findByProps({ testID: 'consent-target-claude-m1' }).props.onPress());
    online = false;
    await press(r, '检查其他可用目标');
    const extra = r.root.findByProps({ testID: 'consent-target-claude-m1' });
    expect(extra.props.selected).toBe(true);
    expect(extra.props.role).toBe('checkbox');
    expect(r.root.findAllByType('Button').find((n: any) => n.props.title === '允许连接').props.disabled).toBe(true);
    await act(async () => extra.props.onPress());
    await press(r, '允许连接');
    expect(approve.mock.calls[0][1].targets).toHaveLength(1);
});
