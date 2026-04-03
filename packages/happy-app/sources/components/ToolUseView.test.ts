import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pushSpy, codeViewSpy, sectionSpy, toolErrorSpy, markdownSpy, permissionFooterSpy, questionViewSpy, mockSessionState } = vi.hoisted(() => ({
    pushSpy: vi.fn(),
    codeViewSpy: vi.fn(({ code }: { code: string }) => React.createElement('Text', null, code)),
    sectionSpy: vi.fn(({ title, children }: { title?: string; children: React.ReactNode }) => (
        React.createElement('View', null, title ? React.createElement('Text', null, title) : null, children)
    )),
    toolErrorSpy: vi.fn(({ message }: { message: string }) => React.createElement('Text', null, `error:${message}`)),
    markdownSpy: vi.fn(({ markdown }: { markdown: string }) => React.createElement('Text', null, markdown)),
    permissionFooterSpy: vi.fn((props: any) => React.createElement('View', { testID: 'permission-footer' },
        React.createElement('Text', null, `permission:${props.permission.status}`)
    )),
    questionViewSpy: vi.fn((props: any) => React.createElement('View', { testID: 'question-view' },
        React.createElement('Text', null, `question:${props.question.resolved ? 'resolved' : 'pending'}`)
    )),
    mockSessionState: { current: null as any },
}));

vi.mock('react-native', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
    View: ({ children, ...props }: any) => React.createElement('View', props, children),
    Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
    Image: (props: any) => React.createElement('Image', props),
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: any) => (typeof factory === 'function' ? factory({
            colors: {
                text: '#000',
                textSecondary: '#666',
                surface: '#fff',
                modal: { border: '#ccc' },
            },
        }) : factory),
    },
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: pushSpy }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => null,
}));

vi.mock('./CodeView', () => ({
    CodeView: codeViewSpy,
}));

vi.mock('./tools/ToolSectionView', () => ({
    ToolSectionView: sectionSpy,
}));

vi.mock('./tools/ToolError', () => ({
    ToolError: toolErrorSpy,
}));

vi.mock('./markdown/MarkdownView', () => ({
    MarkdownView: markdownSpy,
}));

vi.mock('./tools/PermissionFooter', () => ({
    PermissionFooter: permissionFooterSpy,
}));

vi.mock('./ToolUseQuestionView', () => ({
    ToolUseQuestionView: questionViewSpy,
}));

vi.mock('@/sync/storage', () => ({
    useSyncSessionState: () => mockSessionState.current,
}));

import { ToolUseView } from './ToolUseView';

function makeToolUse(overrides: Partial<{ id: string; name: string; raw_input: string; input: any; is_input_complete: boolean }> = {}) {
    return {
        id: 'tool-1',
        name: 'Read',
        raw_input: '{}',
        input: {},
        is_input_complete: true,
        ...overrides,
    };
}

function makePermission(overrides: Partial<{
    permissionId: string; callId: string; resolved: boolean;
    decision: 'once' | 'always' | 'reject'; allowTools: string[]; reason: string;
}> = {}) {
    return {
        sessionId: 'session-1',
        messageId: null,
        callId: 'tool-1',
        permissionId: 'perm-1',
        block: { type: 'permission' as const, id: 'perm-1', permission: 'Read', patterns: [], always: [], metadata: {} },
        resolved: false,
        ...overrides,
    };
}

function makeQuestion(overrides: Partial<{
    questionId: string; callId: string; resolved: boolean; answers: string[][];
}> = {}) {
    return {
        sessionId: 'session-1',
        messageId: null,
        callId: 'tool-1',
        questionId: 'q-1',
        block: {
            type: 'question' as const,
            id: 'q-1',
            questions: [{
                question: 'Which framework?',
                header: 'Framework',
                options: [
                    { label: 'Vitest', description: 'Fast' },
                    { label: 'Jest', description: 'Legacy' },
                ],
            }],
        },
        resolved: false,
        ...overrides,
    };
}

describe('ToolUseView', () => {
    beforeEach(() => {
        pushSpy.mockClear();
        codeViewSpy.mockClear();
        sectionSpy.mockClear();
        toolErrorSpy.mockClear();
        markdownSpy.mockClear();
        permissionFooterSpy.mockClear();
        questionViewSpy.mockClear();
        mockSessionState.current = null;
    });

    it('renders completed tool input and text output', () => {
        act(() => {
            create(React.createElement(ToolUseView, {
                sessionId: 'session-1',
                messageId: 'msg:1',
                toolUse: makeToolUse({
                    raw_input: '{"path":"/tmp/file"}',
                    input: { path: '/tmp/file' },
                }),
                toolResult: {
                    tool_use_id: 'tool-1',
                    tool_name: 'Read',
                    is_error: false,
                    content: { Text: 'file contents' },
                },
            }));
        });

        expect(codeViewSpy).toHaveBeenCalledTimes(1);
        const codeProps = codeViewSpy.mock.calls[0]?.[0] as { code: string } | undefined;
        expect(codeProps?.code).toContain('"path": "/tmp/file"');
        expect(markdownSpy).toHaveBeenCalledTimes(1);
        const markdownProps = markdownSpy.mock.calls[0]?.[0] as { markdown: string } | undefined;
        expect(markdownProps?.markdown).toBe('file contents');
    });

    it('hides tool input while the input is still streaming', () => {
        act(() => {
            create(React.createElement(ToolUseView, {
                sessionId: 'session-1',
                messageId: 'msg:1',
                toolUse: makeToolUse({ is_input_complete: false }),
            }));
        });

        expect(codeViewSpy).not.toHaveBeenCalled();
    });

    it('renders tool errors from matching SessionToolResult values', () => {
        act(() => {
            create(React.createElement(ToolUseView, {
                toolUse: makeToolUse(),
                toolResult: {
                    tool_use_id: 'tool-1',
                    tool_name: 'Read',
                    is_error: true,
                    content: { Text: 'permission denied' },
                },
            }));
        });

        expect(toolErrorSpy).toHaveBeenCalledTimes(1);
        const errorProps = toolErrorSpy.mock.calls[0]?.[0] as { message: string } | undefined;
        expect(errorProps?.message).toBe('permission denied');
    });

    // ─── Permission rendering tests ────────────────────────────────────

    it('renders PermissionFooter when a pending permission matches the tool', () => {
        mockSessionState.current = {
            permissions: [makePermission()],
            questions: [],
        };

        let tree: any;
        act(() => {
            tree = create(React.createElement(ToolUseView, {
                sessionId: 'session-1',
                messageId: 'msg:1',
                toolUse: makeToolUse(),
            }));
        });

        expect(permissionFooterSpy).toHaveBeenCalledTimes(1);
        const props = permissionFooterSpy.mock.calls[0]?.[0] as any;
        expect(props.permission.status).toBe('pending');
        expect(props.permission.id).toBe('perm-1');
        expect(props.sessionId).toBe('session-1');
        expect(props.toolName).toBe('Read');
    });

    it('renders PermissionFooter with approved state for resolved permission', () => {
        mockSessionState.current = {
            permissions: [makePermission({ resolved: true, decision: 'once' })],
            questions: [],
        };

        act(() => {
            create(React.createElement(ToolUseView, {
                sessionId: 'session-1',
                messageId: 'msg:1',
                toolUse: makeToolUse(),
            }));
        });

        expect(permissionFooterSpy).toHaveBeenCalledTimes(1);
        const props = permissionFooterSpy.mock.calls[0]?.[0] as any;
        expect(props.permission.status).toBe('approved');
        expect(props.permission.decision).toBe('approved');
    });

    it('renders PermissionFooter with denied state for rejected permission', () => {
        mockSessionState.current = {
            permissions: [makePermission({ resolved: true, decision: 'reject', reason: 'User denied' })],
            questions: [],
        };

        act(() => {
            create(React.createElement(ToolUseView, {
                sessionId: 'session-1',
                messageId: 'msg:1',
                toolUse: makeToolUse(),
            }));
        });

        expect(permissionFooterSpy).toHaveBeenCalledTimes(1);
        const props = permissionFooterSpy.mock.calls[0]?.[0] as any;
        expect(props.permission.status).toBe('denied');
        expect(props.permission.reason).toBe('User denied');
    });

    it('renders approved_for_session decision for always permission', () => {
        mockSessionState.current = {
            permissions: [makePermission({ resolved: true, decision: 'always', allowTools: ['Read'] })],
            questions: [],
        };

        act(() => {
            create(React.createElement(ToolUseView, {
                sessionId: 'session-1',
                messageId: 'msg:1',
                toolUse: makeToolUse(),
            }));
        });

        const props = permissionFooterSpy.mock.calls[0]?.[0] as any;
        expect(props.permission.status).toBe('approved');
        expect(props.permission.decision).toBe('approved_for_session');
        expect(props.permission.allowedTools).toEqual(['Read']);
    });

    it('does not render PermissionFooter when no permission matches', () => {
        mockSessionState.current = {
            permissions: [makePermission({ callId: 'other-tool' })],
            questions: [],
        };

        act(() => {
            create(React.createElement(ToolUseView, {
                sessionId: 'session-1',
                messageId: 'msg:1',
                toolUse: makeToolUse(),
            }));
        });

        expect(permissionFooterSpy).not.toHaveBeenCalled();
    });

    it('does not render PermissionFooter without a session', () => {
        act(() => {
            create(React.createElement(ToolUseView, {
                toolUse: makeToolUse(),
            }));
        });

        expect(permissionFooterSpy).not.toHaveBeenCalled();
    });

    // ─── Question rendering tests ──────────────────────────────────────

    it('renders ToolUseQuestionView for AskUserQuestion tool with pending question', () => {
        mockSessionState.current = {
            permissions: [],
            questions: [makeQuestion()],
        };

        act(() => {
            create(React.createElement(ToolUseView, {
                sessionId: 'session-1',
                messageId: 'msg:1',
                toolUse: makeToolUse({ name: 'AskUserQuestion' }),
            }));
        });

        expect(questionViewSpy).toHaveBeenCalledTimes(1);
        const props = questionViewSpy.mock.calls[0]?.[0] as any;
        expect(props.question.questionId).toBe('q-1');
        expect(props.question.resolved).toBe(false);
        expect(props.sessionId).toBe('session-1');
    });

    it('renders ToolUseQuestionView for AskUserQuestion tool with resolved question', () => {
        mockSessionState.current = {
            permissions: [],
            questions: [makeQuestion({ resolved: true, answers: [['Vitest']] })],
        };

        act(() => {
            create(React.createElement(ToolUseView, {
                sessionId: 'session-1',
                messageId: 'msg:1',
                toolUse: makeToolUse({ name: 'AskUserQuestion' }),
            }));
        });

        expect(questionViewSpy).toHaveBeenCalledTimes(1);
        const props = questionViewSpy.mock.calls[0]?.[0] as any;
        expect(props.question.resolved).toBe(true);
    });

    it('does not render question view for non-AskUserQuestion tools', () => {
        mockSessionState.current = {
            permissions: [],
            questions: [makeQuestion()],
        };

        act(() => {
            create(React.createElement(ToolUseView, {
                sessionId: 'session-1',
                messageId: 'msg:1',
                toolUse: makeToolUse({ name: 'Read' }),
            }));
        });

        expect(questionViewSpy).not.toHaveBeenCalled();
    });

    it('does not render PermissionFooter for AskUserQuestion tool', () => {
        mockSessionState.current = {
            permissions: [makePermission()],
            questions: [makeQuestion()],
        };

        act(() => {
            create(React.createElement(ToolUseView, {
                sessionId: 'session-1',
                messageId: 'msg:1',
                toolUse: makeToolUse({ name: 'AskUserQuestion' }),
            }));
        });

        // Question view shown, but not permission footer
        expect(questionViewSpy).toHaveBeenCalledTimes(1);
        expect(permissionFooterSpy).not.toHaveBeenCalled();
    });
});
