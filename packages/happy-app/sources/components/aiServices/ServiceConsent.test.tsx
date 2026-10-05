import * as React from 'react';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { render, press, snapshot, worker, account, catalog } from './testSupport';
import { ServiceConsent } from './ServiceConsent';
const pairing = { id: 'p1', protocol: 'ai-services/1', publicKey: 'key', expiresAt: Date.now() + 60000, app: { appId: 'advisor', name: '狗头军师', origins: ['https://advisor.example'], capabilities: ['chat', 'images'], businessPrompt: { id: 'prompt', version: '1' } } } as const;
it('prefills the service and shows the full consent scope, separate from browser storage', async () => {
    const approve = vi.fn(async () => {});
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
