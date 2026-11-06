import * as React from 'react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error no declarations in workspace
import TestRenderer from 'react-test-renderer';
import { FileViewPanel } from './FileViewPanel';
const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), alert: vi.fn() }));
vi.mock('react-native', () => ({ View: 'View', ScrollView: 'ScrollView', ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable', Platform: { OS: 'web' } }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/components/markdown/MarkdownView', () => ({ MarkdownView: 'MarkdownView' }));
vi.mock('@/components/diff/PierreDiffView', () => ({ PierreDiffView: 'Diff' }));
vi.mock('@/components/CodeEditor', () => ({ CodeEditor: 'Editor' }));
vi.mock('@/sync/ops', () => ({ sessionReadFile: mocks.read, sessionWriteFile: mocks.write }));
vi.mock('@/modal', () => ({ Modal: { alert: mocks.alert } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/components/layout', () => ({ layout: { maxWidth: 1000 } }));
vi.mock('react-native-unistyles', () => {
    const theme = { colors: { surface: 'surface', surfacePressed: 'pressed', surfaceHigh: 'high', text: 'text', textSecondary: 'secondary', warning: 'warning', divider: 'divider', input: { background: 'input' }, groupped: { background: 'group' } } };
    return { StyleSheet: { create: (factory: any) => factory(theme) }, useUnistyles: () => ({ theme }) };
});
const encoded = (content: string) => ({ success: true, content: btoa(content) });
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.read.mockReset().mockResolvedValue(encoded('first'));
    mocks.write.mockReset().mockResolvedValue({ success: true, hash: 'saved' });
    mocks.alert.mockReset();
});
async function mount(expectEditor = true) {
    let renderer: any;
    let changeFile!: (path: string) => void;
    const Harness = () => {
        const [header, setHeader] = React.useState<React.ReactNode>(null);
        const [path, setPath] = React.useState('/file.ts');
        changeFile = setPath;
        return <>{header}<FileViewPanel sessionId="s1" filePath={path} onHeaderRightSlotChange={setHeader} /></>;
    };
    await act(async () => { renderer = TestRenderer.create(<Harness />); });
    if (expectEditor) await vi.waitFor(async () => { await act(async () => { await Promise.resolve(); }); expect(renderer.root.findAllByType('Editor')).toHaveLength(1); });
    renderer.changeFile = (path: string) => changeFile(path);
    return renderer;
}
describe('FileViewPanel explicit refresh', () => {
    it('does not install a file reread interval', async () => {
        const interval = vi.spyOn(globalThis, 'setInterval');
        const renderer = await mount();
        expect(interval).not.toHaveBeenCalled();
        expect(mocks.read).toHaveBeenCalledTimes(1);
        await act(async () => renderer.unmount()); interval.mockRestore();
    });
    it('lets the user retry an initial read error', async () => {
        mocks.read.mockResolvedValueOnce({ success: false, error: 'Machine is offline' });
        const renderer = await mount(false);
        expect(JSON.stringify(renderer.toJSON())).toContain('Machine is offline');
        await act(async () => renderer.root.findByProps({ testID: 'file-panel-refresh' }).props.onPress());
        await vi.waitFor(() => expect(renderer.root.findByType('Editor').props.value).toBe('first'));
        expect(mocks.read).toHaveBeenCalledTimes(2);
        await act(async () => renderer.unmount());
    });
    it('refreshes once on user action and accepts an empty file', async () => {
        const renderer = await mount();
        mocks.read.mockResolvedValue(encoded(''));
        await act(async () => renderer.root.findByProps({ testID: 'file-panel-refresh' }).props.onPress());
        expect(mocks.read).toHaveBeenCalledTimes(2);
        expect(renderer.root.findByType('Editor').props.value).toBe('');
        await act(async () => renderer.unmount());
    });
    it('preserves dirty edits and shows a conflict when refresh finds changes', async () => {
        const renderer = await mount();
        await act(async () => renderer.root.findByType('Editor').props.onChange('mine'));
        mocks.read.mockResolvedValue(encoded('remote change'));
        await act(async () => renderer.root.findByProps({ testID: 'file-panel-refresh' }).props.onPress());
        expect(renderer.root.findByType('Editor').props.value).toBe('mine');
        expect(JSON.stringify(renderer.toJSON())).toContain('files.fileConflict');
        expect(mocks.write).not.toHaveBeenCalled();
        await act(async () => renderer.unmount());
    });
    it('reports refresh errors without losing edits', async () => {
        const renderer = await mount();
        await act(async () => renderer.root.findByType('Editor').props.onChange('mine'));
        mocks.read.mockResolvedValue({ success: false, error: 'Machine is offline' });
        await act(async () => renderer.root.findByProps({ testID: 'file-panel-refresh' }).props.onPress());
        expect(renderer.root.findByType('Editor').props.value).toBe('mine');
        expect(JSON.stringify(renderer.toJSON())).toContain('Machine is offline');
        await act(async () => renderer.unmount());
    });
    it('ignores a late refresh even after navigating away and back to the same file', async () => {
        const renderer = await mount();
        let finish!: (response: any) => void;
        mocks.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        let pending!: Promise<void>;
        await act(async () => { pending = renderer.root.findByProps({ testID: 'file-panel-refresh' }).props.onPress(); });
        await act(async () => renderer.changeFile('/other.ts'));
        await vi.waitFor(() => expect(renderer.root.findAllByType('Editor')).toHaveLength(1));
        await act(async () => renderer.changeFile('/file.ts'));
        await vi.waitFor(() => expect(renderer.root.findAllByType('Editor')).toHaveLength(1));
        await act(async () => { finish(encoded('STALE')); await pending; });
        expect(renderer.root.findByType('Editor').props.value).toBe('first');
        await act(async () => renderer.unmount());
    });
    it('resets the saving state on navigation and ignores the previous file save completion', async () => {
        const renderer = await mount();
        await act(async () => renderer.root.findByType('Editor').props.onChange('A edits'));
        let finish!: (response: any) => void;
        mocks.write.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const saveButton = () => renderer.root.findAllByType('Pressable').find((node: any) =>
            node.findAllByType('Text').some((text: any) => text.props.children === 'files.saveFile'));
        let pending!: Promise<void>;
        await act(async () => { pending = saveButton().props.onPress(); });
        await act(async () => renderer.changeFile('/other.ts'));
        await vi.waitFor(() => expect(renderer.root.findAllByType('Editor')).toHaveLength(1));
        await act(async () => renderer.root.findByType('Editor').props.onChange('B edits'));
        expect(renderer.root.findByProps({ testID: 'file-panel-refresh' }).props.disabled).toBe(false);
        expect(saveButton().props.disabled).toBe(false);
        await act(async () => { finish({ success: true, hash: 'old-save' }); await pending; });
        expect(renderer.root.findByType('Editor').props.value).toBe('B edits');
        expect(saveButton().props.disabled).toBe(false);
        await act(async () => saveButton().props.onPress());
        expect(mocks.write.mock.calls[1][1]).toBe('/other.ts');
        await act(async () => renderer.unmount());
    });
    it('aborts force overwrite when the latest content cannot be read', async () => {
        const renderer = await mount();
        await act(async () => renderer.root.findByType('Editor').props.onChange('mine'));
        mocks.write.mockResolvedValue({ success: false, error: 'hash mismatch' });
        mocks.read.mockResolvedValue(encoded('remote change'));
        const save = renderer.root.findAllByType('Pressable').find((node: any) => node.findAllByType('Text').some((text: any) => text.props.children === 'files.saveFile'));
        await act(async () => save.props.onPress());
        mocks.write.mockClear(); mocks.read.mockResolvedValue({ success: false, error: 'read failed' });
        const overwrite = renderer.root.findAllByType('Pressable').find((node: any) => node.findAllByType('Text').some((text: any) => text.props.children === 'files.overwrite'));
        await act(async () => overwrite.props.onPress());
        expect(mocks.write).not.toHaveBeenCalled();
        expect(mocks.alert).toHaveBeenCalledWith('common.error', 'read failed');
        await act(async () => renderer.unmount());
    });
});
