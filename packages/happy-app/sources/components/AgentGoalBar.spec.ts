import * as React from 'react';
import { ActivityIndicator } from 'react-native';
import { describe, expect, it, vi } from 'vitest';
import type { VisibleAgentGoalStatus } from './agentGoalStatus';

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Icon', props),
}));

vi.mock('react-native', () => ({
    ActivityIndicator: (props: Record<string, unknown>) => React.createElement('ActivityIndicator', props),
    Pressable: ({ children, ...props }: Record<string, any>) => React.createElement('Pressable', props, children),
    Text: ({ children, ...props }: Record<string, any>) => React.createElement('Text', props, children),
    View: ({ children, ...props }: Record<string, any>) => React.createElement('View', props, children),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                surfaceHigh: '#242424',
                surfacePressed: '#303030',
                text: '#ffffff',
                textSecondary: '#a0a0a0',
                divider: '#444444',
                button: {
                    secondary: {
                        tint: '#c0c0c0',
                    },
                },
            },
        },
    }),
}));

vi.mock('@/text', () => ({
    t: (key: string, params?: { goal?: string }) => {
        const values: Record<string, string> = {
            'components.agentGoalBar.currentGoal': 'Current goal',
            'components.agentGoalBar.clearGoal': 'Clear goal',
            'components.agentGoalBar.pauseGoal': 'Pause goal',
            'components.agentGoalBar.resumeGoal': 'Resume goal',
            'components.agentGoalBar.editGoal': 'Edit goal',
            'components.agentGoalBar.statusPaused': 'Paused',
            'components.agentGoalBar.statusBlocked': 'Blocked',
            'components.agentGoalBar.statusUsageLimited': 'Usage limited',
            'components.agentGoalBar.statusBudgetLimited': 'Budget limited',
        };
        if (key === 'components.agentGoalBar.accessibilityLabel') {
            return `Current goal: ${params?.goal ?? ''}`;
        }
        return values[key] ?? key;
    },
}));

const goal: VisibleAgentGoalStatus = {
    status: 'active',
    source: 'claude',
    text: 'finish the current task',
    observedAt: 11_000,
    sourceSessionId: 'claude-session-1',
    providerStatus: 'active',
};

type ElementWithProps = React.ReactElement<Record<string, any>>;

function childrenOf(node: React.ReactNode): React.ReactNode[] {
    if (!React.isValidElement(node)) {
        return [];
    }
    return React.Children.toArray((node as ElementWithProps).props.children);
}

function textContent(node: React.ReactNode): string {
    if (typeof node === 'string' || typeof node === 'number') {
        return String(node);
    }
    return childrenOf(node).map(textContent).join('');
}

function findAllByLabel(node: React.ReactNode, label: string): ElementWithProps[] {
    const matches: ElementWithProps[] = [];
    if (React.isValidElement(node)) {
        const element = node as ElementWithProps;
        if (element.props.accessibilityLabel === label) {
            matches.push(element);
        }
        for (const child of childrenOf(element)) {
            matches.push(...findAllByLabel(child, label));
        }
    }
    return matches;
}

function findAllByType(node: React.ReactNode, type: React.ElementType): ElementWithProps[] {
    const matches: ElementWithProps[] = [];
    if (React.isValidElement(node)) {
        const element = node as ElementWithProps;
        if (element.type === type) {
            matches.push(element);
        }
        for (const child of childrenOf(element)) {
            matches.push(...findAllByType(child, type));
        }
    }
    return matches;
}

async function renderGoalBar(props: Record<string, unknown>): Promise<ElementWithProps> {
    const { AgentGoalBar } = await import('./AgentGoalBar');
    return AgentGoalBar(props as any) as ElementWithProps;
}

describe('AgentGoalBar', () => {
    it('renders the current goal label and text', async () => {
        const element = await renderGoalBar({ goal });

        expect(textContent(element)).toContain('Current goal');
        expect(textContent(element)).toContain('finish the current task');
        expect(textContent(element)).not.toContain('Active');
        expect(findAllByLabel(element, 'Current goal: finish the current task')).toHaveLength(1);
    });

    it('does not render action buttons without an action handler', async () => {
        const element = await renderGoalBar({
            goal: {
                ...goal,
                capabilities: { clear: true, pause: true, edit: true },
            },
        });

        expect(findAllByLabel(element, 'Clear goal')).toHaveLength(0);
        expect(findAllByLabel(element, 'Pause goal')).toHaveLength(0);
        expect(findAllByLabel(element, 'Edit goal')).toHaveLength(0);
    });

    it('renders and dispatches explicit action capabilities', async () => {
        const onAction = vi.fn();
        const element = await renderGoalBar({
            goal: {
                ...goal,
                capabilities: { clear: true, pause: false, edit: true },
            },
            onAction,
        });

        const clearButton = findAllByLabel(element, 'Clear goal')[0];
        const editButton = findAllByLabel(element, 'Edit goal')[0];
        expect(findAllByLabel(element, 'Pause goal')).toHaveLength(0);

        clearButton.props.onPress();
        editButton.props.onPress();

        expect(onAction).toHaveBeenNthCalledWith(1, 'clear');
        expect(onAction).toHaveBeenNthCalledWith(2, 'edit');
    });

    it('renders only the actions explicitly reported by the agent', async () => {
        const element = await renderGoalBar({
            goal: {
                ...goal,
                capabilities: { edit: true },
            },
            onAction: vi.fn(),
        });

        expect(findAllByLabel(element, 'Edit goal')).toHaveLength(1);
        expect(findAllByLabel(element, 'Clear goal')).toHaveLength(0);
        expect(findAllByLabel(element, 'Pause goal')).toHaveLength(0);
    });

    it('renders and dispatches Pause for an active goal', async () => {
        const onAction = vi.fn();
        const element = await renderGoalBar({
            goal: {
                ...goal,
                providerStatus: 'active',
                capabilities: { pause: true },
            },
            onAction,
        });

        const pauseButton = findAllByLabel(element, 'Pause goal')[0];
        expect(findAllByLabel(element, 'Resume goal')).toHaveLength(0);

        pauseButton.props.onPress();
        expect(onAction).toHaveBeenCalledWith('pause');
    });

    it('renders Paused state and dispatches Resume for a paused goal', async () => {
        const onAction = vi.fn();
        const element = await renderGoalBar({
            goal: {
                ...goal,
                providerStatus: 'paused',
                capabilities: { resume: true },
            },
            onAction,
        });

        expect(textContent(element)).toContain('Current goal · Paused');
        expect(findAllByLabel(element, 'Current goal: finish the current task. Paused')).toHaveLength(1);
        const resumeButton = findAllByLabel(element, 'Resume goal')[0];
        expect(findAllByLabel(element, 'Pause goal')).toHaveLength(0);

        resumeButton.props.onPress();
        expect(onAction).toHaveBeenCalledWith('resume');
    });

    it.each([
        ['blocked', 'Blocked'],
        ['usageLimited', 'Usage limited'],
        ['budgetLimited', 'Budget limited'],
    ] as const)('renders %s state without a lifecycle action', async (providerStatus, label) => {
        const element = await renderGoalBar({
            goal: {
                ...goal,
                providerStatus,
                capabilities: { pause: true, resume: true, clear: true },
            },
            onAction: vi.fn(),
        });

        expect(textContent(element)).toContain(`Current goal · ${label}`);
        expect(findAllByLabel(element, 'Pause goal')).toHaveLength(0);
        expect(findAllByLabel(element, 'Resume goal')).toHaveLength(0);
        expect(findAllByLabel(element, 'Clear goal')).toHaveLength(1);
    });

    it('disables every action while showing a spinner only on the in-flight action', async () => {
        const onAction = vi.fn();
        const element = await renderGoalBar({
            goal: {
                ...goal,
                capabilities: { clear: true, edit: true },
            },
            onAction,
            inFlightAction: 'clear',
        });

        const clearButton = findAllByLabel(element, 'Clear goal')[0];
        const editButton = findAllByLabel(element, 'Edit goal')[0];
        expect(clearButton.props.accessibilityState).toEqual({ disabled: true });
        expect(editButton.props.accessibilityState).toEqual({ disabled: true });
        expect(findAllByType(element, ActivityIndicator)).toHaveLength(1);
    });
});
