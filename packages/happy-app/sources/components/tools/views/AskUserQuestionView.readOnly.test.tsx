import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';
import { AskUserQuestionView } from './AskUserQuestionView';
import { TranscriptReadOnlyContext } from '../../TranscriptReadOnlyContext';
import { sessionAllow } from '@/sync/ops';

vi.mock('react-native', () => ({ View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity', ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/sync/ops', () => ({ sessionAllow: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('../ToolSectionView', () => ({ ToolSectionView: 'ToolSectionView' }));
vi.mock('react-native-unistyles', () => {
    const colors: any = new Proxy({}, { get: () => colors });
    return { StyleSheet: { create: (factory: any) => factory({ colors }) }, useUnistyles: () => ({ theme: { colors } }) };
});
const tool: any = {
    name: 'AskUserQuestion', state: 'running', permission: { id: 'permission-1', status: 'pending' },
    input: { questions: [{ question: 'Continue?', header: 'Next', multiSelect: false, options: [{ label: 'Yes', description: '' }] }] },
};
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(sessionAllow).mockClear();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => consoleErrorSpy.mockRestore());

it('keeps historical questions visible but disables selection and submission', () => {
    let renderer: any;
    act(() => { renderer = TestRenderer.create(<TranscriptReadOnlyContext.Provider value={true}>
        <AskUserQuestionView tool={tool} metadata={null} messages={[]} sessionId="old-session" />
    </TranscriptReadOnlyContext.Provider>); });
    const buttons = renderer.root.findAllByType('TouchableOpacity');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].props.disabled).toBe(true);
    act(() => buttons[0].props.onPress());
    expect(sessionAllow).not.toHaveBeenCalled();
    act(() => renderer.unmount());
});

it('still submits answers to the active session without a read-only provider', async () => {
    let renderer: any;
    act(() => { renderer = TestRenderer.create(<AskUserQuestionView tool={tool} metadata={null} messages={[]} sessionId="active-session" />); });
    act(() => renderer.root.findAllByType('TouchableOpacity')[0].props.onPress());
    await act(async () => renderer.root.findAllByType('TouchableOpacity')[1].props.onPress());
    expect(sessionAllow).toHaveBeenCalledWith('active-session', 'permission-1', undefined, undefined, 'approved', { answers: { 'Continue?': 'Yes' } });
    act(() => renderer.unmount());
});
