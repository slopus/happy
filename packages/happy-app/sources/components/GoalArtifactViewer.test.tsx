import * as React from 'react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error no declarations in workspace
import TestRenderer from 'react-test-renderer';
import { GoalArtifactViewer, type GoalArtifactViewerProps } from './GoalArtifactViewer';
const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@/sync/goalBoardArtifacts', async original => ({ ...await original<any>(), openGoalArtifact: mocks.open }));
vi.mock('@/auth/accountRuntime', () => ({ assertAccountRuntime: () => {}, getRuntimeAccountSelection: () => null }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://one.test' }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: {} }));
vi.mock('@/sync/attachmentCacheContext', () => ({ attachmentCacheGeneration: () => 0 }));
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, View: 'View', Text: 'Text', ScrollView: 'ScrollView', ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable' }));
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('@/components/markdown/MarkdownView', () => ({ MarkdownView: 'MarkdownView' }));
vi.mock('@/components/SimpleSyntaxHighlighter', () => ({ SimpleSyntaxHighlighter: 'Syntax' }));
vi.mock('@/components/tools/views/FileView', () => ({ FileView: 'FileView' }));
vi.mock('@/components/GoalHtmlPreview', () => ({ GoalHtmlPreview: 'GoalHtmlPreview' }));
vi.mock('@/utils/openExternalUrl', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { surface: 'surface', surfacePressed: 'pressed', surfaceSelected: 'selected', text: 'text', textSecondary: 'secondary', textDestructive: 'error', divider: 'divider' } } }) }));
const artifact = { id: 'a1', name: '完整.md', kind: 'text', available: true, relation: 'output' } as const;
const task = { id: 't1', title: 'Task', indexPath: '/task/index.md', status: 'done', goal: 'goal', dependencies: [], expectedDeliverables: [], artifacts: [artifact] } as any;
const props = { sessionId: 's1', featurePath: '/feature', task, artifact, onClose: vi.fn() };
const full = '# 原文\n' + 'all original content\n'.repeat(3000);
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.open.mockReset();
    mocks.open.mockResolvedValue({ success: true, kind: 'text', name: artifact.name, revision: '1', content: full });
});
async function mount(input: GoalArtifactViewerProps = props) {
    let renderer: any;
    await act(async () => { renderer = TestRenderer.create(<GoalArtifactViewer {...input} />); });
    return renderer;
}
describe('GoalArtifactViewer original content', () => {
    it('opens only when mounted and renders full Markdown with a source toggle', async () => {
        expect(mocks.open).not.toHaveBeenCalled();
        const renderer = await mount();
        expect(mocks.open.mock.calls[0][0]).toEqual({ sessionId: 's1', featurePath: '/feature', taskId: 't1', artifact });
        expect(renderer.root.findByType('MarkdownView').props).toMatchObject({ markdown: full, readOnly: true });
        await act(async () => renderer.root.findByProps({ testID: 'goal-artifact-source' }).props.onPress());
        expect(renderer.root.findByType('Syntax').props.code).toBe(full);
        await act(async () => renderer.unmount());
    });
    it('detects Markdown from the original filename when the link label is descriptive', async () => {
        mocks.open.mockResolvedValue({ success: true, kind: 'text', name: 'report.md', revision: '1', content: full });
        const renderer = await mount({ ...props, artifact: { ...artifact, name: '验收报告', path: '/goal/report.md' } });
        expect(renderer.root.findByType('MarkdownView').props.markdown).toBe(full);
        await act(async () => renderer.root.findByProps({ testID: 'goal-artifact-source' }).props.onPress());
        expect(renderer.root.findByType('Syntax').props).toMatchObject({ code: full, language: 'markdown' });
        await act(async () => renderer.unmount());
    });
    it('renders full code without turning it into Markdown', async () => {
        mocks.open.mockResolvedValue({ success: true, kind: 'text', name: 'source.ts', revision: '1', content: full });
        const renderer = await mount({ ...props, artifact: { ...artifact, name: 'source.ts' } });
        expect(renderer.root.findAllByType('MarkdownView')).toHaveLength(0);
        expect(renderer.root.findByType('Syntax').props).toMatchObject({ code: full, language: 'typescript', selectable: true });
        await act(async () => renderer.unmount());
    });
    it('opens an HTML original as a document and lets the user switch to its complete source', async () => {
        const content = '<!doctype html><html><body><h1>开发者复现教程</h1><button>Agent</button></body></html>';
        mocks.open.mockResolvedValue({ success: true, kind: 'text', name: 'report.html', revision: '1', content });
        const renderer = await mount({ ...props, artifact: { ...artifact, name: '开发者复现教程', path: '/goal/report.html' } });
        expect(renderer.root.findByType('GoalHtmlPreview').props.content).toBe(content);
        await act(async () => renderer.root.findByProps({ testID: 'goal-artifact-source' }).props.onPress());
        expect(renderer.root.findByType('Syntax').props.code).toBe(content);
        await act(async () => renderer.unmount());
    });
    it('keeps large code and Markdown source complete and selectable without syntax tokenization', async () => {
        const content = '// BEGIN ORIGINAL\n' + 'export const value = { next: () => 42 };\n'.repeat(6500) + '// END ORIGINAL';
        mocks.open.mockResolvedValue({ success: true, kind: 'text', name: 'large.ts', revision: '1', content });
        const renderer = await mount({ ...props, artifact: { ...artifact, name: 'large.ts' } });
        const sourceProps = renderer.root.findByType('Syntax').props;
        expect(sourceProps).toMatchObject({ code: content, language: null, selectable: true });
        // Exercise the actual shared renderer too: null language must keep one complete token,
        // rather than expanding the original into tens of thousands of Text/DOM nodes.
        const { SimpleSyntaxHighlighter } = await vi.importActual<typeof import('./SimpleSyntaxHighlighter')>('./SimpleSyntaxHighlighter');
        let source: any;
        await act(async () => { source = TestRenderer.create(<SimpleSyntaxHighlighter {...sourceProps} />); });
        const tokens = source.root.findAllByType('Text').filter((node: any) => typeof node.props.children === 'string');
        expect(tokens).toHaveLength(1);
        expect(tokens[0].props).toMatchObject({ children: content, selectable: true });
        await act(async () => source.unmount());
        await act(async () => renderer.unmount());
        mocks.open.mockResolvedValue({ success: true, kind: 'text', name: 'large.md', revision: '1', content });
        const markdown = await mount();
        expect(markdown.root.findByType('MarkdownView').props.markdown).toBe(content);
        await act(async () => markdown.root.findByProps({ testID: 'goal-artifact-source' }).props.onPress());
        expect(markdown.root.findByType('Syntax').props).toMatchObject({ code: content, language: null, selectable: true });
        await act(async () => markdown.unmount());
    });
    it.each(['image', 'audio', 'video', 'pdf'])('passes original %s attachment to the existing file renderer', async kind => {
        const attachment = { ref: 'private/ref', name: `original.${kind}`, size: 100, mimeType: kind === 'pdf' ? 'application/pdf' : `${kind}/test`, kind: kind === 'pdf' ? 'file' : kind, encrypted: true };
        mocks.open.mockResolvedValue({ success: true, kind: 'attachment', attachment });
        const renderer = await mount({ ...props, artifact: { ...artifact, kind: kind as any } });
        expect(renderer.root.findByType('FileView').props).toMatchObject({ sessionId: 's1', tool: { name: 'file', state: 'completed', input: attachment } });
        await act(async () => renderer.unmount());
    });
    it('aborts on session changes and ignores a late old response', async () => {
        let finish!: (response: any) => void;
        mocks.open.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const renderer = await mount();
        const signal = mocks.open.mock.calls[0][1];
        await act(async () => renderer.update(<GoalArtifactViewer {...props} sessionId="s2" />));
        expect(signal.aborted).toBe(true);
        await act(async () => finish({ success: true, kind: 'text', name: 'old.md', revision: '0', content: 'STALE' }));
        expect(renderer.root.findByType('MarkdownView').props.markdown).toBe(full);
        await act(async () => renderer.unmount());
        expect(mocks.open.mock.calls[1][1].aborted).toBe(true);
    });
    it('shows explicit errors and retries on a user action', async () => {
        mocks.open.mockRejectedValueOnce(new Error('File exceeds safe limit'));
        const renderer = await mount();
        expect(JSON.stringify(renderer.toJSON())).toContain('File exceeds safe limit');
        await act(async () => renderer.root.findByProps({ testID: 'goal-artifact-retry' }).props.onPress());
        expect(renderer.root.findByType('MarkdownView').props.markdown).toBe(full);
        await act(async () => renderer.unmount());
    });
    it('does not fetch unsupported artifacts', async () => {
        const renderer = await mount({ ...props, artifact: { ...artifact, kind: 'unsupported' as any } });
        expect(mocks.open).not.toHaveBeenCalled();
        expect(JSON.stringify(renderer.toJSON())).toContain('goalBoard.artifactUnsupported');
        await act(async () => renderer.unmount());
    });
});
