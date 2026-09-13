import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rigMetadataFixture } from '@/sync/__testdata__/rigMetadata';

const mocks = vi.hoisted(() => ({
    getGit: vi.fn(), readFile: vi.fn(), bash: vi.fn(), legacyRead: vi.fn(),
    metadata: null as any,
}));
vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
    return { View: host('View'), ActivityIndicator: host('ActivityIndicator'), Pressable: host('Pressable'), Platform: { OS: 'ios' } };
});
vi.mock('expo-router', async () => {
    const ReactModule = await import('react');
    return { useFocusEffect: (effect: React.EffectCallback) => ReactModule.useEffect(effect, [effect]) };
});
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { surface: 'white', text: 'black', textSecondary: 'grey' } } }),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}), mono: () => ({}) } }));
vi.mock('@/components/StyledText', async () => {
    const ReactModule = await import('react');
    return { Text: (props: any) => ReactModule.createElement('Text', props, props.children) };
});
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/sync/ops', () => ({ sessionBash: mocks.bash, sessionReadFile: mocks.legacyRead }));
vi.mock('@/sync/storage', async () => {
    const ReactModule = await import('react');
    return {
        useSettingMutable: () => ReactModule.useState('unified'),
        useSession: () => ({ metadata: mocks.metadata }),
        useSessionGitStatusFiles: () => null,
        storage: { getState: () => ({ sessions: { session: { metadata: mocks.metadata } } }) },
    };
});
vi.mock('@/sync/happyAgentGit', () => ({
    supportsHappyAgentGit: (metadata: typeof rigMetadataFixture) => metadata.rigMetadataVersion === 1
        && ['gitState', 'readFile', 'readFileAtRevision'].every((method) => metadata.capabilities?.rpcMethods.includes(method)),
    getHappyAgentGitState: mocks.getGit,
    readHappyAgentGitFile: mocks.readFile,
}));
vi.mock('@/components/diff/DiffFilesList', async () => {
    const ReactModule = await import('react');
    return { DiffFilesList: (props: any) => ReactModule.createElement('DiffFilesList', props,
        props.header,
        props.items.length === 0 ? ReactModule.createElement('Text', null, props.emptyText) : null,
    ) };
});

import { HappyAgentDiffView } from './HappyAgentDiffView';
import { AllFilesDiffView } from './AllFilesDiffView';

const metadata = {
    ...rigMetadataFixture,
    capabilities: { ...rigMetadataFixture.capabilities!, rpcMethods: ['gitState', 'readFile', 'readFileAtRevision'] },
};
const base = 'a'.repeat(40);
function snapshot(overrides: Record<string, unknown> = {}) {
    return {
        facts: { branch: 'feature', detached: false, head: 'b'.repeat(40), upstream: 'origin/main', ahead: 1, behind: 0 },
        comparison: 'ready', base, changedFiles: 1, insertions: 1, deletions: 1, countsExact: true, conflicted: false,
        files: [{ path: 'src/app.ts', status: 'modified', staged: false, unstaged: false, binary: false, insertions: 1, deletions: 1 }],
        filesTruncated: false, scannedAt: 100, ...overrides,
    };
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}
let renderer: ReturnType<typeof create> | undefined;
let header: any;
const publishHeader = (slot: React.ReactNode) => { header = slot; };
function element(overrides: Record<string, unknown> = {}) {
    return React.createElement(HappyAgentDiffView, { sessionId: 'session', metadata, onHeaderRightSlotChange: publishHeader, ...overrides });
}
async function render(overrides: Record<string, unknown> = {}) {
    await act(async () => { renderer = create(element(overrides)); });
}
function list() { return renderer!.root.findByType('DiffFilesList').props; }
function text() { return renderer!.root.findAllByType('Text').map((node: any) => node.children.join('')).join('\n'); }

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.getGit.mockReset().mockResolvedValue(snapshot());
    mocks.readFile.mockReset().mockResolvedValue({ kind: 'text', oldText: 'old\n', newText: 'new\n' });
    mocks.bash.mockReset();
    mocks.legacyRead.mockReset();
    mocks.metadata = metadata;
    header = null;
});
afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    vi.unstubAllGlobals();
});

describe('Happy Agent Changes view', () => {
    it('loads without publishing a toolbar on the standalone route', async () => {
        await render({ onHeaderRightSlotChange: undefined });
        expect(header).toBeNull();
        expect(list().items).toHaveLength(1);
    });

    it('keeps inline retry available without a header refresh button', async () => {
        mocks.getGit.mockRejectedValueOnce(new Error('Computer did not respond'));
        await render({ onHeaderRightSlotChange: undefined });
        expect(text()).toContain('Computer did not respond');
        await act(async () => renderer!.root.findByType('Pressable').props.onPress());
        expect(list().items).toHaveLength(1);
        expect(header).toBeNull();
    });

    it('shows committed branch changes without shell calls and reads contents only on expansion', async () => {
        await act(async () => {
            renderer = create(React.createElement(AllFilesDiffView, { sessionId: 'session', onHeaderRightSlotChange: publishHeader }));
        });
        expect(mocks.getGit).toHaveBeenCalledExactlyOnceWith('session');
        expect(mocks.bash).not.toHaveBeenCalled();
        expect(mocks.legacyRead).not.toHaveBeenCalled();
        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(list().items).toMatchObject([{ path: 'src/app.ts', source: null, additions: 1, deletions: 1 }]);
        await act(async () => list().onRequestContent('src/app.ts'));
        expect(mocks.readFile).toHaveBeenCalledExactlyOnceWith('session', base, snapshot().files[0]);
        expect(list().items[0].source).toMatchObject({ kind: 'contents', oldText: 'old\n', newText: 'new\n' });
        expect(list().items[0].source.diffBudget).toEqual({ timeoutMs: 200, maxEditLength: 2000 });
    });

    it('does not re-scan or re-read for recreated metadata, whitespace, or expanded context', async () => {
        await render();
        await act(async () => list().onRequestContent('src/app.ts'));
        await act(async () => renderer.update(element({ metadata: { ...metadata } })));
        await act(async () => header.props.onIgnoreWhitespaceChange(true));
        await act(async () => list().onExpandContext('src/app.ts'));
        expect(mocks.getGit).toHaveBeenCalledTimes(1);
        expect(mocks.readFile).toHaveBeenCalledTimes(1);
        expect(list().items[0].source.ignoreWhitespace).toBe(true);
        expect(list().items[0].source.contextLines).toBeGreaterThan(3);
    });

    it('shows upgrade guidance for an older daemon instead of clean state or a shell fallback', async () => {
        await render({ metadata: rigMetadataFixture });
        expect(text()).toContain('Update Happy Agent');
        expect(text()).not.toContain('files.noChanges');
        expect(mocks.getGit).not.toHaveBeenCalled();
        expect(mocks.bash).not.toHaveBeenCalled();
    });

    it('keeps the legacy path for CLI sessions', async () => {
        mocks.metadata = { path: '/repo', flavor: 'codex' };
        await act(async () => {
            renderer = create(React.createElement(AllFilesDiffView, { sessionId: 'session', onHeaderRightSlotChange: publishHeader }));
        });
        expect(mocks.getGit).not.toHaveBeenCalled();
        expect(text()).toContain('files.noChanges');
    });

    it('does not report a clean tree before session metadata arrives', async () => {
        mocks.metadata = null;
        await act(async () => {
            renderer = create(React.createElement(AllFilesDiffView, { sessionId: 'session', onHeaderRightSlotChange: publishHeader }));
        });
        expect(text()).not.toContain('files.noChanges');
        expect(mocks.getGit).not.toHaveBeenCalled();
        expect(renderer!.root.findAllByType('ActivityIndicator')).toHaveLength(1);
    });

    it('shows RPC errors and can explicitly retry', async () => {
        mocks.getGit.mockRejectedValueOnce(new Error('Computer did not respond'));
        await render();
        expect(text()).toContain('Computer did not respond');
        expect(text()).not.toContain('files.noChanges');
        await act(async () => header.props.onRefresh());
        expect(mocks.getGit).toHaveBeenCalledTimes(2);
        expect(list().items).toHaveLength(1);
    });

    it('shows unavailable comparisons separately from a clean workspace', async () => {
        mocks.getGit.mockResolvedValue(snapshot({ comparison: 'unavailable', base: null, files: [], changedFiles: 0 }));
        await render();
        expect(text()).toContain('comparison with origin/main');
        expect(text()).not.toContain('files.noChanges');
        expect(header.props.fileCount).toBeNull();
    });

    it('shows truncation and approximate counts without turning an incomplete list into No changes', async () => {
        mocks.getGit.mockResolvedValue(snapshot({ files: [], changedFiles: 20, filesTruncated: true, countsExact: false }));
        await render();
        expect(text()).toContain('Showing 0 of 20');
        expect(text()).toContain('approximate');
        expect(text()).toContain('No file details');
        expect(text()).not.toContain('files.noChanges');
        expect(header.props.fileCount).toBe(20);
    });

    it('reports a clean ready comparison as No changes', async () => {
        mocks.getGit.mockResolvedValue(snapshot({ files: [], changedFiles: 0 }));
        await render();
        expect(text()).toContain('files.noChanges');
    });

    it('does not claim a clean comparison when a zero count is only an estimate', async () => {
        mocks.getGit.mockResolvedValue(snapshot({ files: [], changedFiles: 0, countsExact: false }));
        await render();
        expect(text()).toContain('approximate');
        expect(text()).not.toContain('files.noChanges');
    });

    it('reloads contents even when paths, counts, base and scan timestamp are unchanged', async () => {
        await render();
        await act(async () => list().onRequestContent('src/app.ts'));
        mocks.readFile.mockResolvedValue({ kind: 'text', oldText: 'old\n', newText: 'changed again\n' });
        await act(async () => header.props.onRefresh());
        expect(list().items[0].source).toBeNull();
        await act(async () => list().onRequestContent('src/app.ts'));
        expect(mocks.getGit).toHaveBeenCalledTimes(2);
        expect(mocks.readFile).toHaveBeenCalledTimes(2);
        expect(list().items[0].source.newText).toBe('changed again\n');
    });

    it('does not turn an empty added file or an individual read failure into an endless spinner', async () => {
        const data = snapshot();
        mocks.getGit.mockResolvedValue({ ...data, files: [{ ...data.files[0], status: 'added' }] });
        mocks.readFile.mockResolvedValueOnce({ kind: 'text', oldText: '', newText: '' });
        await render();
        await act(async () => list().onRequestContent('src/app.ts'));
        expect(list().items[0]).toMatchObject({ kind: 'added', message: 'files.fileEmpty' });
        await act(async () => header.props.onRefresh());
        mocks.readFile.mockRejectedValueOnce(new Error('File disappeared. Reload changes.'));
        await act(async () => list().onRequestContent('src/app.ts'));
        expect(list().items[0]).toMatchObject({ source: null, error: 'File disappeared. Reload changes.' });
    });

    it('discards a delayed Git reply after switching sessions', async () => {
        const old = deferred<ReturnType<typeof snapshot>>();
        mocks.getGit.mockReturnValueOnce(old.promise);
        await render({ key: 'old' });
        await act(async () => renderer.update(element({ key: 'new', sessionId: 'next-session' })));
        await act(async () => old.resolve(snapshot({ files: [], changedFiles: 0 })));
        expect(mocks.getGit).toHaveBeenLastCalledWith('next-session');
        expect(list().items).toHaveLength(1);
    });

    it('discards a delayed file reply from before refresh', async () => {
        const old = deferred<{ kind: 'text'; oldText: string; newText: string }>();
        mocks.readFile.mockReturnValueOnce(old.promise);
        await render();
        await act(async () => list().onRequestContent('src/app.ts'));
        await act(async () => header.props.onRefresh());
        await act(async () => old.resolve({ kind: 'text', oldText: '', newText: 'stale' }));
        expect(list().items[0].source).toBeNull();
        await act(async () => list().onRequestContent('src/app.ts'));
        expect(list().items[0].source.newText).toBe('new\n');
    });
});