import * as React from 'react';
import type { ServiceGrantScope } from '@slopus/happy-wire';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { render, press, snapshot, worker, account, catalog } from './testSupport';
import { ServiceConsent } from './ServiceConsent';
const pairing = { id: 'p1', protocol: 'ai-services/1', publicKey: 'key', expiresAt: Date.now() + 60000, app: { appId: 'advisor', name: '狗头军师', origins: ['https://advisor.example'], capabilities: ['chat', 'images'], businessPrompt: { id: 'prompt', version: '1' } } } as const;
it('prefills the service and shows the full consent scope, separate from browser storage', async () => {
    const approve = vi.fn(async (_service: unknown, _scope: ServiceGrantScope) => {});
    const r = await render(<ServiceConsent pairing={pairing as any} services={[snapshot]} workers={[worker]} accounts={[account as any]} machines={[{ id: 'm1', name: 'Mac' }]} api={{ capabilities: async () => ({ catalog }) } as any} onApprove={approve} onManage={vi.fn()} />);
    const output = JSON.stringify(r.toJSON());
    for (const text of ['狗头军师', '私人助理', 'Mac · Codex · Work', '不包含终端、文件系统或浏览器操作', '记住连接', '授权有效期']) expect(output).toContain(text);
    await press(r, '允许连接');
    expect(approve).toHaveBeenCalledWith(snapshot, expect.objectContaining({ targets: [{ machineId: 'm1', engine: 'codex', accountRef: snapshot.revision.config.accountRef }], permissions: ['chat'], expiresAt: expect.any(Number) }));
    expect(JSON.stringify(approve.mock.calls[0])).not.toContain('remember');
});
it('requires fresh confirmation for image permission and never allows an expired pairing', async () => {
    const approve = vi.fn();
    const r = await render(<ServiceConsent pairing={pairing as any} services={[snapshot]} workers={[worker]} accounts={[account as any]} machines={[]} api={{ capabilities: async () => ({ catalog }) } as any} onApprove={approve} onManage={vi.fn()} />);
    await act(async () => r.root.findByProps({ testID: 'consent-images' }).props.onPress());
    await press(r, '允许连接');
    expect(approve.mock.calls[0][1].permissions).toEqual(['chat', 'images']);
    await act(async () => r.update(<ServiceConsent key="expired" pairing={{ ...pairing, expiresAt: 1 } as any} services={[snapshot]} workers={[worker]} accounts={[]} machines={[]} api={{ capabilities: async () => ({ catalog }) } as any} onApprove={approve} onManage={vi.fn()} />));
    expect(r.root.findAllByType('Button').find((n: any) => n.props.title === '允许连接').props.disabled).toBe(true);
});
it('adds only explicitly selected verified extra targets without asking for model or effort again', async () => {
    const approve = vi.fn(async (_service: unknown, _scope: ServiceGrantScope) => {});
    const claude = { machineId: worker.machineId, engine: 'claude', accountRef: { kind: 'device-identity', machineId: worker.machineId, identityId: worker.serviceClaudeIdentity } };
    const capabilities = vi.fn(async (target) => ({ catalog: { ...catalog, ...target, defaultModelId: target.engine === 'claude' ? null : catalog.defaultModelId } }));
    const r = await render(<ServiceConsent pairing={pairing as any} services={[snapshot]} workers={[worker]} accounts={[account as any]} machines={[]} api={{ capabilities } as any} onApprove={approve} onManage={vi.fn()} />);
    await press(r, '检查其他可用目标');
    const extra = r.root.findByProps({ testID: 'consent-target-claude-m1' });
    expect(extra.props.selected).toBe(false);
    expect(extra.props.disabled).toBe(false);
    await act(async () => extra.props.onPress());
    await press(r, '允许连接');
    expect(approve.mock.calls[0][1].targets).toEqual([{ machineId: 'm1', engine: 'codex', accountRef: snapshot.revision.config.accountRef }, claude]);
    expect(capabilities.mock.calls.map(c => c[0].engine)).toEqual(['codex', 'claude']);
    expect(approve.mock.calls[0][1]).not.toHaveProperty('modelId');
});
it('disables offline and unsupported additional targets and keeps the current target alone by default', async () => {
    const approve = vi.fn(async (_service: unknown, _scope: ServiceGrantScope) => {});
    const workers = [worker, { ...worker, machineId: 'm2', serviceClaudeIdentity: null }];
    const capabilities = vi.fn(async (target) => ({ catalog: { ...catalog, ...target, availability: target.machineId === 'm2' ? 'offline' : 'online', models: target.engine === 'claude' ? [] : catalog.models } }));
    const r = await render(<ServiceConsent pairing={pairing as any} services={[snapshot]} workers={workers} accounts={[account as any]} machines={[]} api={{ capabilities } as any} onApprove={approve} onManage={vi.fn()} />);
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
    const approve = vi.fn(async (_service: unknown, _scope: ServiceGrantScope) => {});
    const api = { capabilities: vi.fn(async (target) => ({ catalog: { ...catalog, ...target, availability: target.engine === 'claude' && !online ? 'offline' : 'online' } })) };
    const r = await render(<ServiceConsent pairing={pairing as any} services={[snapshot]} workers={[worker]} accounts={[account as any]} machines={[]} api={api as any} onApprove={approve} onManage={vi.fn()} />);
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
