import { describe, expect, it, vi } from 'vitest';
import { groupMessagesForDisplay, groupToolCallsForDisplay } from './useGroupedMessages';
import { Message, ToolCallMessage } from '@/sync/typesMessage';

vi.mock('@/components/tools/knownTools', () => ({
    knownTools: {},
}));

vi.mock('@/text', () => ({
    t: (key: string, params?: { count?: number }) => `${key}:${params?.count ?? ''}`,
}));

function toolMessage(
    id: string,
    createdAt: number,
    options: {
        pendingPermission?: boolean;
        state?: ToolCallMessage['tool']['state'];
        completedAt?: number | null;
        name?: string;
    } = {},
): ToolCallMessage {
    const state = options.state ?? 'completed';
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt,
        tool: {
            name: options.name ?? 'CodexBash',
            state,
            input: { command: id },
            createdAt,
            startedAt: createdAt,
            completedAt: options.completedAt ?? (state === 'running' ? null : createdAt + 1),
            description: id,
            ...(options.pendingPermission
                ? {
                    permission: {
                        id: `permission-${id}`,
                        status: 'pending' as const,
                    },
                }
                : {}),
        },
        children: [],
    };
}

function imageAgentPrompt(): string {
    return [
        '使用 $gpt-image-2 skill 执行一次 GPT Image 2 图片编辑 / 生成批处理。',
        '',
        '生成锁：',
        '- 将这次请求视为一个已锁定的图片生成任务。',
        '',
        '输入：已上传 1 张参考图。',
        '输出要求：',
        '- 每保存一张 PNG/JPEG 后，立即用绝对本地路径调用 mcp__happy__send_image 内联发送。',
    ].join('\n');
}

function imageAgentPromptWithStyleCount(styleCount: number, variants: number = 1): string {
    return [
        '使用 $gpt-image-2 skill 执行一次 GPT Image 2 图片编辑 / 生成批处理。',
        '',
        '生成锁：',
        '- 将这次请求视为一个已锁定的图片生成任务。这个锁只用于避免并发图片任务，不限制多风格或多图片输出。',
        '',
        '输出要求：',
        `- 对下面每个选中的风格，各生成 ${variants} 张变体。`,
        '- 每保存一张 PNG/JPEG 后，立即用绝对本地路径调用 mcp__happy__send_image 内联发送。',
        '',
        '已选择的 GPT Image 2 风格：',
        ...Array.from({ length: styleCount }, (_, index) => `${index + 1}. style-${index + 1} - 风格 ${index + 1}`),
    ].join('\n');
}

function fileMessage(id: string, createdAt: number): ToolCallMessage {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt,
        tool: {
            name: 'file',
            state: 'completed',
            input: { ref: `ref-${id}`, name: `${id}.jpg` },
            createdAt,
            startedAt: createdAt,
            completedAt: createdAt + 1,
            description: id,
        },
        children: [],
    };
}

describe('useGroupedMessages', () => {
    it('renders only the latest version of an edited user message', () => {
        const messages: Message[] = [
            {
                kind: 'user-text',
                id: 'edit-2',
                localId: null,
                createdAt: 3,
                text: 'final prompt',
                meta: { editedFromMessageId: 'edit-1-stable' },
            },
            {
                kind: 'user-text',
                id: 'edit-1',
                localId: 'edit-1-stable',
                createdAt: 2,
                text: 'revised prompt',
                meta: { editedFromMessageId: 'original-stable' },
            },
            {
                kind: 'user-text',
                id: 'original',
                localId: 'original-stable',
                createdAt: 1,
                text: 'original prompt',
            },
        ];

        for (const groupingEnabled of [true, false]) {
            const items = groupMessagesForDisplay(messages, groupingEnabled);
            expect(items.map((item) => item.id)).toEqual(['edit-2']);
        }
    });

    it('collapses consecutive user image attachments into one chronological image-group', () => {
        const messages: Message[] = [
            fileMessage('img-3', 4),
            fileMessage('img-2', 3),
            fileMessage('img-1', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'look at these',
            },
        ];

        const items = groupMessagesForDisplay(messages, true);
        const gallery = items.find((item) => item.type === 'image-group');

        expect(gallery).toBeDefined();
        expect(items.filter((item) => item.type === 'image-group')).toHaveLength(1);
        expect((gallery as any).messages.map((m: Message) => m.id)).toEqual([
            'img-1',
            'img-2',
            'img-3',
        ]);
    });

    it('renders a single attachment as a one-item image-group', () => {
        const messages: Message[] = [fileMessage('only', 2)];
        const items = groupMessagesForDisplay(messages, true);
        expect(items).toHaveLength(1);
        expect(items[0].type).toBe('image-group');
        expect((items[0] as any).messages).toHaveLength(1);
    });

    it('still collapses image attachments into a gallery when tool grouping is OFF (default)', () => {
        // Regression: groupToolCalls defaults to false. The thumbnail gallery
        // must NOT depend on that setting, otherwise images render full-width.
        const messages: Message[] = [
            fileMessage('img-2', 3),
            fileMessage('img-1', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'look at these',
            },
        ];

        const items = groupMessagesForDisplay(messages, false);

        expect(items.filter((item) => item.type === 'image-group')).toHaveLength(1);
        const gallery = items.find((item) => item.type === 'image-group');
        expect((gallery as any).messages.map((m: Message) => m.id)).toEqual(['img-1', 'img-2']);
        // The user text message still passes through untouched.
        expect(items.some((item) => item.type === 'message' && item.id === 'user')).toBe(true);
        // Crucially, no attachment leaks through as a raw full-width message.
        expect(items.some((item) => item.type === 'message' && (item.id === 'img-1' || item.id === 'img-2'))).toBe(false);
    });

    it('leaves non-attachment messages untouched when tool grouping is OFF', () => {
        const messages: Message[] = [
            toolMessage('tool-a', 3),
            {
                kind: 'agent-text',
                id: 'agent',
                localId: null,
                createdAt: 2,
                text: 'hi',
            },
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'hello',
            },
        ];

        const items = groupMessagesForDisplay(messages, false);

        expect(items.map((item) => item.type)).toEqual(['message', 'message', 'message']);
        expect(items.map((item) => item.id)).toEqual(['tool-a', 'agent', 'user']);
    });

    it('keeps user and generated videos as individual playable cards', () => {
        const userVideo = fileMessage('user-video', 2);
        userVideo.tool.input = {
            ref: 'sessions/s1/attachments/user.mp4',
            name: 'user.mp4',
            size: 4096,
            kind: 'video',
            mimeType: 'video/mp4',
        };
        const generatedVideo = fileMessage('generated-video', 3);
        generatedVideo.tool.input = {
            ref: 'sessions/s1/attachments/generated.mp4',
            name: 'generated.mp4',
            size: 4096,
            kind: 'video',
            mimeType: 'video/mp4',
            encrypted: false,
            source: 'generated',
        };

        for (const enabled of [false, true]) {
            const grouped = groupMessagesForDisplay([generatedVideo, userVideo], enabled);
            expect(grouped).toHaveLength(2);
            expect(grouped.map((item) => item.type)).toEqual(['message', 'message']);
            expect(grouped.map((item) => item.id)).toEqual(['generated-video', 'user-video']);
        }
    });

    it('keeps PDF documents as individual file cards instead of image galleries', () => {
        const pdf = fileMessage('user-pdf', 2);
        pdf.tool.input = {
            ref: 'sessions/s1/attachments/floor-plan.enc',
            name: 'floor-plan.pdf',
            size: 4096,
            kind: 'file',
            mimeType: 'application/pdf',
        };

        for (const enabled of [false, true]) {
            const grouped = groupMessagesForDisplay([pdf], enabled);
            expect(grouped).toHaveLength(1);
            expect(grouped[0]).toMatchObject({ type: 'message', id: 'user-pdf' });
        }
    });

    it('stores grouped tools in chronological render order', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-after-tools',
                localId: null,
                createdAt: 5,
                text: 'done',
            },
            toolMessage('tool-latest', 4),
            toolMessage('tool-middle', 3),
            toolMessage('tool-earliest', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run tools',
            },
        ];

        const group = groupToolCallsForDisplay(messages, true).find((item) => item.type === 'tool-group');

        expect(group?.messages.map((message) => message.id)).toEqual([
            'tool-earliest',
            'tool-middle',
            'tool-latest',
        ]);
    });

    it('groups only adjacent tool calls between text messages', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-final',
                localId: null,
                createdAt: 7,
                text: 'done',
            },
            toolMessage('tool-4', 6),
            toolMessage('tool-3', 5),
            {
                kind: 'agent-text',
                id: 'agent-middle',
                localId: null,
                createdAt: 4,
                text: 'next step',
            },
            toolMessage('tool-2', 3),
            toolMessage('tool-1', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run tools',
            },
        ];

        const groups = groupToolCallsForDisplay(messages, true).filter((item) => item.type === 'tool-group');

        expect(groups).toHaveLength(2);
        expect(groups[0]?.messages.map((message) => message.id)).toEqual(['tool-3', 'tool-4']);
        expect(groups[1]?.messages.map((message) => message.id)).toEqual(['tool-1', 'tool-2']);
    });

    it('keeps the final agent message visible and collapses earlier agent work', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-final',
                localId: null,
                createdAt: 5,
                text: 'done',
            },
            toolMessage('tool-latest', 4),
            {
                kind: 'agent-text',
                id: 'agent-progress',
                localId: null,
                createdAt: 3,
                text: 'checking',
            },
            toolMessage('tool-earliest', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run tools',
            },
        ];

        const items = groupMessagesForDisplay(messages, true);

        expect(items.map((item) => item.type)).toEqual(['message', 'agent-work-group', 'message']);
        expect(items[0]).toMatchObject({ type: 'message', id: 'agent-final' });
        expect(items[1]).toMatchObject({ type: 'agent-work-group', id: 'work-tool-earliest' });
        if (items[1].type !== 'agent-work-group') {
            throw new Error('Expected an agent work group');
        }
        expect(items[1].messages.map((message) => message.id)).toEqual([
            'tool-latest',
            'agent-progress',
            'tool-earliest',
        ]);
    });

    it('collapses image-agent process text while preserving generated images', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-final',
                localId: null,
                createdAt: 6,
                text: '完成，使用 gpt-image-2 Native 模式生成了 1 张变体，并已内联发送。',
            },
            fileMessage('generated-image', 5),
            {
                kind: 'agent-text',
                id: 'agent-progress',
                localId: null,
                createdAt: 4,
                text: '我会先固化 prompt，然后发送图片。',
            },
            toolMessage('prompt-save', 3),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: imageAgentPrompt(),
            },
        ];

        const items = groupMessagesForDisplay(messages, true);

        expect(items.map((item) => item.type)).toEqual(['image-group', 'agent-work-group', 'message']);
        expect(items.map((item) => item.id)).toEqual(['images-generated-image', 'work-prompt-save', 'user']);
        expect(items.some((item) => item.type === 'message' && (item.id === 'agent-final' || item.id === 'agent-progress'))).toBe(false);
        if (items[0].type !== 'image-group') {
            throw new Error('Expected generated image group');
        }
        expect(items[0].messages.map((message) => message.id)).toEqual(['generated-image']);
        expect(items[0].presentation).toBe('featured');
        if (items[1].type !== 'agent-work-group') {
            throw new Error('Expected image-agent work group');
        }
        expect(items[1].messages.map((message) => message.id)).toEqual([
            'agent-final',
            'agent-progress',
            'prompt-save',
        ]);
        expect(items[1].completedAt).toBe(6);
    });

    it('collapses image-agent process text even when generic tool grouping is off', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-final',
                localId: null,
                createdAt: 6,
                text: '完成，使用 gpt-image-2 Native 模式生成了 1 张变体，并已内联发送。',
            },
            fileMessage('generated-image', 5),
            {
                kind: 'agent-text',
                id: 'agent-progress',
                localId: null,
                createdAt: 4,
                text: '我会先固化 prompt，然后发送图片。',
            },
            toolMessage('prompt-save', 3),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: imageAgentPrompt(),
            },
        ];

        const items = groupMessagesForDisplay(messages, false);

        expect(items.map((item) => item.type)).toEqual(['image-group', 'agent-work-group', 'message']);
        expect(items[0]).toMatchObject({ type: 'image-group', presentation: 'featured' });
        expect(items.some((item) => item.type === 'message' && (item.id === 'agent-final' || item.id === 'agent-progress'))).toBe(false);
    });

    it('marks uploaded reference images and generated image-agent outputs as featured', () => {
        const messages: Message[] = [
            fileMessage('generated-image', 5),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 4,
                text: imageAgentPrompt(),
            },
            fileMessage('reference-image', 3),
        ];

        const items = groupMessagesForDisplay(messages, true);

        expect(items).toMatchObject([
            { type: 'image-group', id: 'images-generated-image', presentation: 'featured', pendingCount: 0 },
            { type: 'message', id: 'user' },
            { type: 'image-group', id: 'images-reference-image', presentation: 'featured', pendingCount: 0 },
        ]);
    });

    it('adds featured loading placeholders for running image-agent outputs before images arrive', () => {
        const messages: Message[] = [
            toolMessage('image-tool-running', 4, { state: 'running' }),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 3,
                text: imageAgentPromptWithStyleCount(3),
            },
            fileMessage('reference-image', 2),
        ];

        const items = groupMessagesForDisplay(messages, true, { collapseCurrentTurn: false });

        expect(items).toMatchObject([
            { type: 'image-group', id: 'images-pending-user', presentation: 'featured', messages: [], pendingCount: 3, pendingStartedAt: 4 },
            { type: 'agent-work-group', id: 'work-image-tool-running', hasRunning: true },
            { type: 'message', id: 'user' },
            { type: 'image-group', id: 'images-reference-image', presentation: 'featured', pendingCount: 0 },
        ]);
    });

    it('keeps only missing loading placeholders once some image-agent outputs have arrived', () => {
        const messages: Message[] = [
            fileMessage('generated-image', 5),
            toolMessage('image-tool-running', 4, { state: 'running' }),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 3,
                text: imageAgentPromptWithStyleCount(3),
            },
            fileMessage('reference-image', 2),
        ];

        const items = groupMessagesForDisplay(messages, true, { collapseCurrentTurn: false });

        expect(items[0]).toMatchObject({
            type: 'image-group',
            id: 'images-generated-image',
            presentation: 'featured',
            pendingCount: 2,
            pendingStartedAt: 4,
        });
    });

    it('keeps the failure summary visible for an image-agent turn without generated images', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-final',
                localId: null,
                createdAt: 5,
                text: '失败：avatars-and-profile/example 因上游限流未生成。',
            },
            toolMessage('prompt-save', 3),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: imageAgentPrompt(),
            },
        ];

        const items = groupMessagesForDisplay(messages, true);

        expect(items.map((item) => item.type)).toEqual(['message', 'agent-work-group', 'message']);
        expect(items[0]).toMatchObject({ type: 'message', id: 'agent-final' });
    });

    it('collapses running image-agent work even while the current turn is active', () => {
        const messages: Message[] = [
            toolMessage('image-tool-running', 3, { state: 'running' }),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: imageAgentPrompt(),
            },
        ];

        const items = groupMessagesForDisplay(messages, true, { collapseCurrentTurn: false });

        expect(items.map((item) => item.type)).toEqual(['image-group', 'agent-work-group', 'message']);
        expect(items[0]).toMatchObject({
            type: 'image-group',
            id: 'images-pending-user',
            pendingCount: 1,
            pendingStartedAt: 3,
            presentation: 'featured',
        });
        expect(items[1]).toMatchObject({
            type: 'agent-work-group',
            id: 'work-image-tool-running',
            hasRunning: true,
            completedAt: null,
        });
    });

    it('keeps current-turn text visible while compacting standalone tools', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-streaming',
                localId: null,
                createdAt: 5,
                text: 'still working',
            },
            toolMessage('tool-latest', 4),
            {
                kind: 'agent-text',
                id: 'agent-progress',
                localId: null,
                createdAt: 3,
                text: 'checking',
            },
            toolMessage('tool-earliest', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run tools',
            },
        ];

        const items = groupMessagesForDisplay(messages, true, { collapseCurrentTurn: false });

        expect(items.map((item) => item.type)).toEqual([
            'message',
            'tool-group',
            'message',
            'tool-group',
            'message',
        ]);
        expect(items.map((item) => item.id)).toEqual([
            'agent-streaming',
            'group-tool-latest',
            'agent-progress',
            'group-tool-earliest',
            'user',
        ]);
    });

    it('still groups adjacent current-turn tools while the agent is working', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-streaming',
                localId: null,
                createdAt: 5,
                text: 'still working',
            },
            toolMessage('tool-latest', 4),
            toolMessage('tool-earliest', 3),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run tools',
            },
        ];

        const items = groupMessagesForDisplay(messages, true, { collapseCurrentTurn: false });

        expect(items.map((item) => item.type)).toEqual(['message', 'tool-group', 'message']);
        expect(items[1]).toMatchObject({
            type: 'tool-group',
            id: 'group-tool-earliest',
            hasPendingPermission: false,
        });
    });

    it('marks a tool group when it contains a pending permission', () => {
        const messages: Message[] = [
            toolMessage('tool-latest', 3, { pendingPermission: true }),
            toolMessage('tool-earliest', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run tools',
            },
        ];

        const group = groupMessagesForDisplay(messages, true).find((item) => item.type === 'tool-group');

        expect(group).toMatchObject({
            type: 'tool-group',
            id: 'group-tool-earliest',
            hasPendingPermission: true,
        });
    });

    it('collapses a single standalone tool call into a compact tool group', () => {
        const messages: Message[] = [
            toolMessage('tool-only', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run one tool',
            },
        ];

        const items = groupMessagesForDisplay(messages, true);

        expect(items.map((item) => item.type)).toEqual(['tool-group', 'message']);
        expect(items[0]).toMatchObject({
            type: 'tool-group',
            id: 'group-tool-only',
            hasPendingPermission: false,
            messages: [{ id: 'tool-only' }],
        });
    });

    it('renders a standalone Skill as a compact tool group', () => {
        const skill = toolMessage('skill-only', 2, { name: 'Skill' });
        skill.tool.input = { skillNames: ['diagnosing-bugs'] };

        const items = groupMessagesForDisplay([skill], true);

        expect(items).toMatchObject([{
            type: 'tool-group',
            id: 'group-skill-only',
            messages: [{ id: 'skill-only' }],
        }]);
    });

    it('keeps a standalone question visible so it remains interactive', () => {
        const question = toolMessage('question-only', 2, { name: 'AskUserQuestion' });
        const items = groupMessagesForDisplay([question], true);

        expect(items).toEqual([
            { type: 'message', id: 'question-only', message: question },
        ]);
    });

    it('can collapse single standalone tool calls for nested work details', () => {
        const messages: Message[] = [
            toolMessage('tool-only', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run one tool',
            },
        ];

        const items = groupToolCallsForDisplay(messages, true, { groupSingleToolCalls: true });

        expect(items.map((item) => item.type)).toEqual(['tool-group', 'message']);
        expect(items[0]).toMatchObject({
            type: 'tool-group',
            id: 'group-tool-only',
            hasPendingPermission: false,
        });
        if (items[0].type !== 'tool-group') {
            throw new Error('Expected a tool group');
        }
        expect(items[0].messages.map((message) => message.id)).toEqual(['tool-only']);
    });
});
