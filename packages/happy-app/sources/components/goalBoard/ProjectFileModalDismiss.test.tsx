// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error RN Web runtime is installed without a declarations package.
vi.mock('react-native', async () => import('react-native-web'));
vi.mock('@/components/WebModalBackdrop', async () => import('../WebModalBackdrop.web'));
vi.mock('react-native-unistyles', async () => {
    const { appThemes } = await import('@/themePacks'); const theme = appThemes.ginghamDark;
    return { useUnistyles: () => ({ theme }), StyleSheet: { hairlineWidth: 1, create: (factory: any) => factory(theme) } };
});
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/hooks/useProjectModalEscape', () => ({ useProjectModalEscape() {} }));
vi.mock('@/hooks/useLibraryItems', () => ({ useLibraryItems: () => ({}) }));
vi.mock('@/auth/accountRuntime', () => ({ getRuntimeAccountSelection: () => null }));
vi.mock('@/sync/storage', () => ({ useMachine: () => null }));
vi.mock('@/sync/projectGoals', () => ({ projectFeatureFiles: () => ({ readOnly: true }), projectSavedFileBinding: () => ({ readOnly: true }), projectGoalRequest: vi.fn() }));
vi.mock('@/components/fileWorkspace/SessionFileWorkspaceProvider', () => ({ SessionFileWorkspaceProvider: ({ children }: any) => children }));
vi.mock('@/components/fileWorkspace/context', () => ({ useFileWorkspace: () => ({ snapshot: { open: false }, openReference: vi.fn() }) }));
vi.mock('@/components/fileWorkspace/FileWorkspace', () => ({ FileWorkspace: () => null }));
vi.mock('./ProjectArchiveTree', () => ({ ProjectArchiveTree: () => null }));
vi.mock('./MobileProjectFileReader', () => ({ MobileProjectFileReader: () => null }));
vi.mock('./LibraryItemActions', () => ({ LibraryItemActions: () => null }));
vi.mock('./GoalBoardButton', () => ({ GoalBoardButton: ({ children, onPress, label }: any) => <button onClick={onPress} aria-label={label}>{children}</button> }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
import { ProjectFeatureFiles } from './ProjectFeatureFiles';
import { ProjectSavedFile } from './ProjectSavedFile';

let root: Root; let host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); });
describe('read-only project file dialogs', () => {
    it.each(['feature', 'saved'])('closes %s from its backdrop and keeps content clicks inside', kind => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        host = document.createElement('div'); document.body.append(host); root = createRoot(host);
        const onClose = vi.fn();
        act(() => root.render(kind === 'feature'
            ? <ProjectFeatureFiles machineId="test" featurePath="/project" title="Files" onClose={onClose} />
            : <ProjectSavedFile machineId="test" item={{ projectPath: '/project/file.md', scopePath: '/project' } as any} onClose={onClose} />));
        const content = document.querySelector(`[data-testid="${kind === 'feature' ? 'project-feature-files-panel' : 'project-saved-file'}"]`) as HTMLElement;
        act(() => content.click()); expect(onClose).not.toHaveBeenCalled();
        act(() => (document.querySelector(`[data-testid="project-${kind === 'feature' ? 'feature-files' : 'saved-file'}-backdrop"]`) as HTMLElement).click());
        expect(onClose).toHaveBeenCalledOnce();
    });
    it('leaves native file dialogs on their existing close controls', async () => {
        const { WebModalBackdrop: NativeBackdrop } = await vi.importActual<typeof import('../WebModalBackdrop')>('../WebModalBackdrop');
        expect(NativeBackdrop({ onClose: vi.fn(), testID: 'native' })).toBeNull();
    });
});
