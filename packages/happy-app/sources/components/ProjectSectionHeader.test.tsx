import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectSectionHeader, prepareNewSessionForProject } from './ProjectSectionHeader';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only needs the small create/unmount surface typed below.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    setMachineId: vi.fn(),
    setPath: vi.fn(),
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    Pressable: 'Pressable',
    View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: unknown) => typeof factory === 'function'
            ? (factory as (theme: any) => object)({
                colors: {
                    surfacePressed: '#ddd',
                    surfaceSelected: '#eee',
                    text: '#111',
                    textSecondary: '#666',
                },
            })
            : factory,
    },
    useUnistyles: () => ({
        theme: { colors: { text: '#111', textSecondary: '#666' } },
    }),
}));
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/hooks/useNewSessionDraft', () => ({
    useNewSessionDraft: {
        getState: () => ({
            setMachineId: mocks.setMachineId,
            setPath: mocks.setPath,
        }),
    },
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('./StatusDot', () => ({ StatusDot: 'StatusDot' }));
vi.mock('./SessionActionsPopover', () => ({ SessionActionsPopover: 'SessionActionsPopover' }));

const session = {
    id: 'session-1',
    name: 'Console task',
    path: '/Users/jacky/console',
} as any;

function renderHeader(overrides: Record<string, unknown> = {}) {
    const props = {
        activity: { color: '#00f', isPulsing: false },
        current: false,
        displayPath: '~/console',
        expanded: true,
        machineId: 'machine-1',
        onCreateSession: vi.fn(),
        onToggle: vi.fn(),
        path: '/Users/jacky/console',
        session,
        testID: 'project-console',
        ...overrides,
    };
    let renderer: any;
    act(() => {
        renderer = TestRenderer.create(<ProjectSectionHeader {...props as any} />);
    });
    return { props, renderer };
}

function findHostByTestId(renderer: any, testID: string) {
    return renderer.root.findAll((node: any) => (
        typeof node.type === 'string' && node.props.testID === testID
    ))[0];
}

describe('ProjectSectionHeader desktop hover actions', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => consoleErrorSpy.mockRestore());

    it('shows the matching more and new-session icons only while hovered', () => {
        const { renderer } = renderHeader();
        const header = findHostByTestId(renderer, 'project-console-container');

        expect(renderer.root.findAllByProps({ testID: 'project-console-actions' })).toHaveLength(0);
        expect(renderer.root.findAllByType('StatusDot')).toHaveLength(1);

        act(() => header.props.onMouseEnter());

        const actions = renderer.root.findByProps({ testID: 'project-console-actions' });
        expect(actions.findByProps({ testID: 'project-console-more-action' }).findByType('Feather').props.name)
            .toBe('more-horizontal');
        expect(actions.findByProps({ testID: 'project-console-new-session-action' }).findByType('Feather').props.name)
            .toBe('edit-3');
        expect(renderer.root.findAllByType('StatusDot')).toHaveLength(0);

        act(() => header.props.onMouseLeave());
        expect(renderer.root.findAllByProps({ testID: 'project-console-actions' })).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('keeps the original project disclosure interaction intact', () => {
        const onToggle = vi.fn();
        const { renderer } = renderHeader({ onToggle });

        act(() => findHostByTestId(renderer, 'project-console').props.onPress());

        expect(onToggle).toHaveBeenCalledOnce();
        act(() => renderer.unmount());
    });

    it('preselects the project before opening the existing new-session flow', () => {
        const onCreateSession = vi.fn();
        const { renderer } = renderHeader({ onCreateSession });
        const header = findHostByTestId(renderer, 'project-console-container');
        act(() => header.props.onMouseEnter());
        const stopPropagation = vi.fn();

        act(() => renderer.root.findByProps({ testID: 'project-console-new-session-action' }).props.onPress({
            preventDefault: vi.fn(),
            stopPropagation,
        }));

        expect(mocks.setMachineId).toHaveBeenCalledWith('machine-1');
        expect(mocks.setPath).toHaveBeenCalledWith('/Users/jacky/console');
        expect(mocks.setMachineId.mock.invocationCallOrder[0]).toBeLessThan(mocks.setPath.mock.invocationCallOrder[0]);
        expect(onCreateSession).toHaveBeenCalledOnce();
        expect(stopPropagation).toHaveBeenCalledOnce();
        act(() => renderer.unmount());
    });

    it('opens the unchanged session action popover from the more icon and right click', () => {
        const { renderer } = renderHeader();
        const header = findHostByTestId(renderer, 'project-console-container');
        act(() => header.props.onMouseEnter());
        const anchorTarget = {
            getBoundingClientRect: () => ({ left: 20, top: 30, width: 28, height: 28 }),
        };

        act(() => renderer.root.findByProps({ testID: 'project-console-more-action' }).props.onPress({
            currentTarget: anchorTarget,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        }));

        let popover = renderer.root.findByType('SessionActionsPopover');
        expect(popover.props).toMatchObject({
            anchor: { type: 'rect', x: 20, y: 30, width: 28, height: 28 },
            sessionId: 'session-1',
            visible: true,
        });

        act(() => popover.props.onClose());
        const disclosure = findHostByTestId(renderer, 'project-console');
        act(() => disclosure.props.onContextMenu({
            currentTarget: anchorTarget,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        }));

        popover = renderer.root.findByType('SessionActionsPopover');
        expect(popover.props.visible).toBe(true);
        expect(popover.props.sessionId).toBe('session-1');
        act(() => renderer.unmount());
    });
});

describe('prepareNewSessionForProject', () => {
    it('updates machine before path so setMachineId cannot clear the selected project', () => {
        prepareNewSessionForProject('machine-2', '/repo/project');

        expect(mocks.setMachineId).toHaveBeenCalledWith('machine-2');
        expect(mocks.setPath).toHaveBeenCalledWith('/repo/project');
        expect(mocks.setMachineId.mock.invocationCallOrder[0]).toBeLessThan(mocks.setPath.mock.invocationCallOrder[0]);
    });
});
