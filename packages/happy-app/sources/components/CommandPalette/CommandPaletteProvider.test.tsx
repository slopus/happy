import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// react-test-renderer 没有发布 TypeScript 类型；测试只使用 create/unmount。
// @ts-expect-error 测试只依赖这里使用的最小 API。
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    modalShow: vi.fn(),
    modalConfirm: vi.fn(),
    modalState: { modals: [] as any[] },
    logout: vi.fn(),
    navigateToSession: vi.fn(),
    router: {
        navigate: vi.fn(),
        push: vi.fn(),
    },
    keyboardHandler: undefined as (() => void) | undefined,
    keyboardOptions: undefined as { onOpenSettings?: () => void } | undefined,
    openSettings: vi.fn(),
    state: {
        sessions: {
            abc123456: {
                id: 'abc123456',
                updatedAt: 2,
                metadata: {
                    summary: { text: 'Launch plan' },
                    path: '/Users/jacky/projects/alpha',
                    homeDir: '/Users/jacky',
                    host: 'mac-mini.local',
                    machineId: 'machine-1',
                    flavor: 'codex',
                },
            },
            history987: {
                id: 'history987',
                updatedAt: 1,
                metadata: {
                    summary: { text: 'Unloaded historical session' },
                    path: '/Users/jacky/projects/archive',
                    host: 'mac-mini.local',
                    machineId: 'machine-1',
                },
            },
        },
        sessionMessages: {
            abc123456: {
                isLoaded: true,
                messages: [{
                    kind: 'user-text',
                    id: 'message-1',
                    localId: null,
                    createdAt: 1,
                    text: 'Investigate the payment timeout from the first report',
                }],
            },
        },
        machines: {
            'machine-1': {
                id: 'machine-1',
                metadata: { displayName: 'Mac mini', host: 'mac-mini.local' },
            },
        },
        localSettings: {
            commandPaletteEnabled: false,
            agents: [{
                id: 'agent-1',
                name: 'Release Agent',
                machineId: 'machine-1',
                path: '~/projects/alpha',
            }],
        },
        currentViewingSessionId: 'abc123456',
    },
}));

vi.stubGlobal('__DEV__', false);
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
}));

vi.mock('expo-router', () => ({
    useRouter: () => mocks.router,
}));

vi.mock('@/modal', () => ({
    Modal: { confirm: mocks.modalConfirm },
    useModal: () => ({
        state: mocks.modalState,
        showModal: mocks.modalShow,
    }),
}));

vi.mock('@/auth/AuthContext', () => ({
    useAuth: () => ({ logout: mocks.logout }),
}));

vi.mock('@/sync/storage', () => ({
    storage: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
}));

vi.mock('zustand/react/shallow', () => ({
    useShallow: <T,>(selector: T) => selector,
}));

vi.mock('@/hooks/useNavigateToSession', () => ({
    useNavigateToSession: () => mocks.navigateToSession,
}));

vi.mock('@/hooks/useGlobalKeyboard', () => ({
    useGlobalKeyboard: (
        handler: (() => void) | undefined,
        options?: { onOpenSettings?: () => void },
    ) => {
        mocks.keyboardHandler = handler;
        mocks.keyboardOptions = options;
    },
}));
vi.mock('@/components/DesktopSettingsModal', () => ({
    useDesktopSettingsModal: () => ({ openSettings: mocks.openSettings }),
}));

vi.mock('@/text', () => ({
    t: (key: string) => {
        const translations: Record<string, string> = {
            'newSession.title': '新会话',
            'sessionHistory.title': '会话',
            'sessionHistory.viewAll': '全部会话',
            'settings.title': '设置',
            'settings.account': '账户',
            'settings.developerTools': '开发者工具',
            'settings.developer': '开发',
            'settingsAccount.linkNewDevice': '连接新设备',
            'settingsAccount.logout': '退出登录',
            'settingsAccount.logoutConfirm': '确定退出登录吗？',
            'common.logout': '退出登录',
            'machine.untitledSession': '无标题会话',
            'commandPalette.navigation': '导航',
            'commandPalette.recentSessions': '最近会话',
            'commandPalette.system': '系统',
            'rightPanelCapabilityHub.blocks.folderBrowser': '文件夹',
            'tools.names.searchFiles': '搜索文件',
        };
        return translations[key] ?? `译文：${key}`;
    },
}));

vi.mock('./CommandPalette', () => ({
    CommandPalette: () => null,
}));

import { CommandPaletteProvider, useCommandPaletteLauncher } from './CommandPaletteProvider';
import type { Command } from './types';

let latestLauncher: ReturnType<typeof useCommandPaletteLauncher> = null;

function LauncherProbe() {
    latestLauncher = useCommandPaletteLauncher();
    return null;
}

describe('CommandPaletteProvider', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let renderer: any;

    beforeEach(() => {
        mocks.modalShow.mockReset();
        mocks.modalShow.mockImplementation((config: any) => {
            const id = `modal-${mocks.modalState.modals.length + 1}`;
            mocks.modalState.modals = [...mocks.modalState.modals, { ...config, id }];
            return id;
        });
        mocks.modalConfirm.mockReset();
        mocks.modalState.modals = [];
        mocks.logout.mockReset();
        mocks.navigateToSession.mockReset();
        mocks.router.navigate.mockReset();
        mocks.router.push.mockReset();
        mocks.keyboardHandler = undefined;
        mocks.keyboardOptions = undefined;
        mocks.openSettings.mockReset();
        latestLauncher = null;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    it('静态命令和跨项目会话元数据均进入同一个面板', () => {
        act(() => {
            renderer = TestRenderer.create(
                <CommandPaletteProvider>
                    <></>
                </CommandPaletteProvider>,
            );
        });

        act(() => {
            mocks.keyboardHandler?.();
        });

        expect(mocks.modalShow).toHaveBeenCalledOnce();
        const commands = mocks.modalShow.mock.calls[0][0].props.commands as Command[];
        const byId = new Map(commands.map((command) => [command.id, command]));

        expect(byId.get('new-session')).toMatchObject({
            title: '新会话',
            category: '会话',
            subtitle: '译文：commandPalette.newSessionSubtitle',
        });
        expect(byId.get('settings')).toMatchObject({
            title: '设置',
            category: '导航',
            subtitle: '译文：commandPalette.settingsSubtitle',
        });
        expect(byId.get('session-abc123456')).toMatchObject({
            title: 'Launch plan',
            subtitle: '/Users/jacky/projects/alpha',
            category: '最近会话',
            showWhenEmpty: true,
            keywords: expect.arrayContaining([
                '/Users/jacky/projects/alpha',
                'alpha',
                'Mac mini',
                'Release Agent',
                'codex',
                'Investigate the payment timeout from the first report',
            ]),
            metadata: expect.arrayContaining([
                { icon: 'chatbubble-outline', text: 'Investigate the payment timeout from the first report' },
                { icon: 'folder-outline', text: 'alpha' },
                { icon: 'desktop-outline', text: 'Mac mini' },
                { icon: 'sparkles-outline', text: 'Release Agent · Codex' },
            ]),
        });
        expect(byId.get('open-project-folder')).toMatchObject({
            title: '文件夹',
            subtitle: '/Users/jacky/projects/alpha',
        });
        expect(byId.get('search-project-files')).toMatchObject({
            title: '搜索文件',
            subtitle: '/Users/jacky/projects/alpha',
        });
        expect(byId.get('session-history987')).toMatchObject({
            title: 'Unloaded historical session',
            subtitle: '/Users/jacky/projects/archive',
        });

        act(() => byId.get('open-project-folder')?.action());
        expect(mocks.router.push).toHaveBeenCalledWith('/session/abc123456/files');
        act(() => byId.get('search-project-files')?.action());
        expect(mocks.router.push).toHaveBeenCalledWith('/session/abc123456/files?focus=search');
    });

    it('keeps Command+P available when stale local storage contains the removed opt-out', () => {
        act(() => {
            renderer = TestRenderer.create(
                <CommandPaletteProvider>
                    <LauncherProbe />
                </CommandPaletteProvider>,
            );
        });

        expect(mocks.keyboardHandler).toBeTypeOf('function');
        expect(latestLauncher?.isAvailable).toBe(true);
        act(() => mocks.keyboardHandler?.());
        expect(mocks.modalShow).toHaveBeenCalledOnce();
    });

    it('opens app settings from the global settings shortcut', () => {
        act(() => {
            renderer = TestRenderer.create(
                <CommandPaletteProvider>
                    <></>
                </CommandPaletteProvider>,
            );
        });

        act(() => mocks.keyboardOptions?.onOpenSettings?.());
        expect(mocks.openSettings).toHaveBeenCalledOnce();
        expect(mocks.router.push).not.toHaveBeenCalledWith('/settings');
    });

    it('does not stack repeated shortcut opens and can open again after the palette closes', () => {
        const renderTree = (phase: string) => (
            <CommandPaletteProvider>
                <LauncherProbe key={phase} />
            </CommandPaletteProvider>
        );
        act(() => {
            renderer = TestRenderer.create(renderTree('initial'));
        });

        act(() => {
            mocks.keyboardHandler?.();
            mocks.keyboardHandler?.();
        });
        expect(mocks.modalShow).toHaveBeenCalledOnce();

        act(() => renderer.update(renderTree('open')));
        mocks.modalState.modals = [];
        act(() => renderer.update(renderTree('closed')));
        act(() => mocks.keyboardHandler?.());
        expect(mocks.modalShow).toHaveBeenCalledTimes(2);
    });

    it('requires destructive confirmation before the sign-out command logs out', async () => {
        act(() => {
            renderer = TestRenderer.create(
                <CommandPaletteProvider>
                    <></>
                </CommandPaletteProvider>,
            );
        });
        act(() => mocks.keyboardHandler?.());
        const commands = mocks.modalShow.mock.calls[0][0].props.commands as Command[];
        const signOut = commands.find((command) => command.id === 'sign-out');

        mocks.modalConfirm.mockResolvedValueOnce(false);
        await act(async () => {
            await signOut?.action();
        });
        expect(mocks.logout).not.toHaveBeenCalled();

        mocks.modalConfirm.mockResolvedValueOnce(true);
        await act(async () => {
            await signOut?.action();
        });
        expect(mocks.modalConfirm).toHaveBeenCalledWith(
            '退出登录',
            '确定退出登录吗？',
            { confirmText: '退出登录', destructive: true },
        );
        expect(mocks.logout).toHaveBeenCalledOnce();
    });

    afterEach(() => {
        if (renderer) {
            act(() => renderer.unmount());
        }
        renderer = undefined;
        consoleErrorSpy.mockRestore();
    });
});
