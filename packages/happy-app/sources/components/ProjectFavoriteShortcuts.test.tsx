import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appThemes } from '@/themePacks';
import { ProjectFavoriteShortcuts } from './ProjectFavoriteShortcuts';

const mock = vi.hoisted(() => ({
    path: '/projects', params: {} as Record<string, string>, owner: 'a', current: true, push: vi.fn(), selectedMachine: vi.fn(),
    shortcuts: [] as any[],
}));
vi.mock('react-native', () => ({ View: 'View', ScrollView: 'ScrollView', Text: 'Text', Pressable: 'Pressable', Platform: { OS: 'web', select: (values: any) => values.web ?? values.default } }));
vi.mock('expo-router', () => ({ useGlobalSearchParams: () => mock.params, useRouter: () => ({ push: mock.push }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
vi.mock('@/auth/accountRuntime', () => ({ accountRuntimeCurrent: () => mock.current }));
vi.mock('@/sync/projectLibrary', () => ({ projectLibraryOwner: () => mock.owner }));
vi.mock('@/sync/storage', () => ({ useLocalSetting: () => '/projects?machine=saved&project=%2Fp' }));
vi.mock('@/hooks/useDesktopWorkspacePathname', () => ({ useDesktopWorkspacePathname: () => mock.path }));
vi.mock('@/hooks/useProjectFavoriteShortcuts', () => ({ useProjectFavoriteShortcuts: (machine?: string) => { mock.selectedMachine(machine); return { machineId: machine ?? 'm', owner: mock.owner, shortcuts: mock.shortcuts }; } }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('./DesktopShortcutTooltip', () => ({ DesktopShortcutTooltip: 'Tooltip' }));
vi.mock('./ComposerTooltipHost', () => ({ ComposerTooltipHost: ({ children, visible }: any) => React.createElement('TooltipHost', { visible }, children) }));
vi.mock('./goalBoard/GoalBoardCard', () => ({ GoalBoardCardFocus: React.createContext(null) }));
vi.mock('react-native-unistyles', async () => {
    const { appThemes } = await import('@/themePacks');
    return { useUnistyles: () => ({ theme: appThemes.ginghamDark }), StyleSheet: { create: (factory: any) => factory(appThemes.ginghamDark) } };
});
let renderer: any;
function mount() { act(() => { renderer = TestRenderer.create(<ProjectFavoriteShortcuts />); }); }
function buttons() { return renderer.root.findAllByType('Pressable'); }
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    mock.path = '/projects'; mock.params = { machine: 'm', project: '/p', feature: '/p/video', task: 'old-task', conversation: 'old-chat', file: 'old.md' };
    mock.owner = 'a'; mock.current = true; mock.push.mockClear(); mock.selectedMachine.mockClear();
    mock.shortcuts = [
        { key: 'video', title: 'Video review', path: '/p/video', kind: 'feature', location: { machine: 'm', project: '/p', feature: '/p/video' } },
        { key: 'other', title: 'Other project', path: '/other', kind: 'project', location: { machine: 'm', project: '/other', feature: undefined } },
    ];
});
afterEach(() => { if (renderer) act(() => renderer.unmount()); renderer = null; });

it('preserves the selected workspace and switches with a complete clean destination', () => {
    mount();
    expect(buttons().map((button: any) => button.props.accessibilityState.selected)).toEqual([true, false]);
    act(() => buttons()[0].props.onPress()); expect(mock.push).not.toHaveBeenCalled();
    act(() => buttons()[1].props.onPress());
    expect(mock.push).toHaveBeenCalledExactlyOnceWith({ pathname: '/projects', params: { machine: 'm', project: '/other' } });
    expect(renderer.root.findByType('ScrollView').props.horizontal).toBe(true);
});

it('uses gingham semantic selected, hover and keyboard focus states', () => {
    mount(); const [selected, other] = buttons();
    const flatten = (style: any[]) => Object.assign({}, ...style.filter(Boolean));
    expect(flatten(selected.props.style({ pressed: false })).backgroundColor).toBe(appThemes.ginghamDark.colors.surfaceSelected);
    expect(flatten(other.props.style({ pressed: false })).backgroundColor).toBe('transparent');
    act(() => other.props.onHoverIn());
    expect(flatten(buttons()[1].props.style({ pressed: false })).backgroundColor).toBe(appThemes.ginghamDark.colors.surfacePressed);
    act(() => { buttons()[1].props.onHoverOut(); buttons()[1].props.onFocus(); });
    expect(flatten(buttons()[1].props.style({ pressed: false })).borderColor).toBe(appThemes.ginghamDark.colors.textLink);
    expect(buttons()[1].findByType('Tooltip').props.visible).toBe(true);
    expect(buttons()[1].findByType('TooltipHost').props.visible).toBe(true);
    expect(buttons()[1].findByType('Tooltip').props.multiline).toBe(true);
});

it('fences stale account callbacks and follows remembered ownership outside projects', () => {
    mock.path = '/session/chat'; mount();
    expect(mock.selectedMachine).toHaveBeenLastCalledWith('saved');
    expect(buttons().every((button: any) => !button.props.accessibilityState.selected)).toBe(true);
    const stalePress = buttons()[1].props.onPress;
    mock.owner = 'b'; act(() => stalePress()); expect(mock.push).not.toHaveBeenCalled();
});

it('offers the project library when nothing is starred without borrowing a remembered machine on the projects route', () => {
    mock.params = {}; mock.shortcuts = []; mount();
    expect(mock.selectedMachine).toHaveBeenLastCalledWith(undefined);
    expect(buttons()[0].props.testID).toBe('desktop-project-favorites-empty');
    act(() => buttons()[0].props.onPress());
    expect(mock.push).toHaveBeenCalledExactlyOnceWith({ pathname: '/projects', params: { machine: 'm' } });
});
