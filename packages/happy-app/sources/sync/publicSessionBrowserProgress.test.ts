import { describe, expect, it } from 'vitest';
import { publicSessionSnapshotSchema } from '@slopus/happy-wire';
import { buildPublicSessionSnapshot } from './publicSessionSnapshot';
import { publicSessionSnapshotToMessages } from './publicSessionSnapshotAdapter';
import { getBrowserStepRuns, hideLinkedBrowserSteps } from '@/components/rightPanel/browserStepRunsModel';
import { getSkillNamesFromTool } from '@/utils/conversationActivity';
import type { ToolCallMessage } from './typesMessage';

const tool = (id: string, createdAt: number, name: string, input: any): ToolCallMessage => ({
    kind: 'tool-call', id, localId: null, createdAt, children: [],
    tool: { name, input, state: 'completed', createdAt, startedAt: createdAt, completedAt: createdAt, description: null },
});
const skill = tool('private-invocation', 1, 'Skill', { skill: 'ego-browser', path: '/Users/private/key' });
const frame = tool('private-frame', 2, 'file', { ref: 'private-ref', name: 'screenshot.png', source: 'browser_step',
    browserStep: { label: 'Checked result', runId: 'private-run', skillName: 'ego-browser' } });
const build = () => buildPublicSessionSnapshot({ title: 'Share', messages: [frame, skill], sharedAt: 10, themePack: 'gingham',
    createAttachmentId: () => '11111111-1111-4111-8111-111111111111' });

describe('public Skills browser evidence', () => {
    it('round trips only presentation metadata and links frames to their named Skill', () => {
        const { snapshot } = build();
        expect(publicSessionSnapshotSchema.safeParse(snapshot).success).toBe(true);
        const serialized = JSON.stringify(snapshot);
        for (const secret of ['private-invocation', 'private-frame', 'private-ref', 'private-run', '/Users/private']) expect(serialized).not.toContain(secret);
        const messages = publicSessionSnapshotToMessages(snapshot, { attachmentUrl: id => `https://public.test/${id}` });
        const invocation = messages.find(m => m.kind === 'tool-call' && m.tool.name === 'Skill') as ToolCallMessage;
        expect(getSkillNamesFromTool(invocation.tool)).toEqual(['ego-browser']);
        const runs = getBrowserStepRuns(messages);
        expect(runs).toHaveLength(1);
        expect(runs[0].invocationMessageId).toBe(invocation.id);
        expect(runs[0].steps[0]).toMatchObject({ label: 'Checked result', ref: 'https://public.test/11111111-1111-4111-8111-111111111111' });
        expect(hideLinkedBrowserSteps(messages, runs)).toHaveLength(1);
    });
    it('groups legacy screenshots within each user turn and leaves ordinary images visible', () => {
        const { snapshot } = build();
        const attachment = snapshot.messages[0].blocks[0];
        delete (attachment as any).browserStep;
        snapshot.messages = [
            { id: 'b-frame', role: 'assistant', createdAt: 5, blocks: [attachment] },
            { id: 'b-user', role: 'user', createdAt: 4, blocks: [{ type: 'text', markdown: 'Next task' }] },
            { id: 'a-frame-2', role: 'assistant', createdAt: 3, blocks: [attachment] },
            { id: 'ordinary', role: 'assistant', createdAt: 2, blocks: [{ ...attachment, source: 'generated' } as typeof attachment] },
            { id: 'a-frame', role: 'assistant', createdAt: 2, blocks: [attachment] },
            { id: 'a-user', role: 'user', createdAt: 1, blocks: [{ type: 'text', markdown: 'First task' }] },
        ];
        const messages = publicSessionSnapshotToMessages(snapshot);
        const runs = getBrowserStepRuns(messages);
        expect(runs.map(run => run.steps.map(step => step.id))).toEqual([['a-frame', 'a-frame-2'], ['b-frame']]);
        const visible = hideLinkedBrowserSteps(messages, runs);
        expect(visible.filter(m => m.kind === 'tool-call' && m.tool.name === 'file').map(m => m.id)).toEqual(['ordinary']);
    });

    it('keeps old published browser screenshots reachable but out of the attachment gallery', () => {
        const { snapshot } = build();
        for (const message of snapshot.messages) for (const block of message.blocks) {
            delete (block as any).browserStep;
            delete (block as any).skillNames;
            delete (block as any).browserRunId;
        }
        const messages = publicSessionSnapshotToMessages(snapshot);
        const runs = getBrowserStepRuns(messages);
        expect(runs).toHaveLength(1);
        const visible = hideLinkedBrowserSteps(messages, runs);
        expect(visible.some(m => m.kind === 'tool-call' && m.tool.name === 'file')).toBe(false);
        expect(runs[0].steps).toHaveLength(1);
    });
});
