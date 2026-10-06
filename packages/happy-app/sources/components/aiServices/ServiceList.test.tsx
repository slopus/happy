import * as React from 'react';
import { expect, it, vi } from 'vitest';
import { render, snapshot } from './testSupport';
import { ServiceList } from './ServiceList';
it('keeps requested and actual model separate and shows app references without secrets', async () => {
    const r = await render(<ServiceList services={[snapshot]} selected="s1" onSelect={vi.fn()} onCreate={vi.fn()} onEdit={vi.fn()} onMetadata={vi.fn()} onRemove={vi.fn()} onRevoke={vi.fn()} machines={[]} accounts={[]} busy={false}
        grants={[{ id: 'g', revokedAt: null, kind: 'personal-grant', scope: { appId: 'advisor', expiresAt: null, targets: [snapshot.revision.config], permissions: ['chat'] } } as any]} apps={{ advisor: '狗头军师' }} turns={[{ id: 'turn', bindingId: 'binding', state: 'completed', actual: { modelId: null, reasoning: null }, createdAt: '2026-10-05T00:00:00Z', startedAt: null, completedAt: null, serviceError: null }]} bindings={{ binding: { ...snapshot.revision.config, id: 'binding', appId: 'advisor', serviceId: 's1', revision: 2, requestedModel: 'requested-model', permissions: ['chat'] } }} />);
    const output = JSON.stringify(r.toJSON());
    for (const text of ['狗头军师', 'requested-model', '实际模型：未知', '实际思考设置：未知', '原对话']) expect(output).toContain(text);
});
