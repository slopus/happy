import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/typesMessage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-device-info', () => ({
    getDeviceType: () => 'Handset',
}));

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    ScrollView: 'ScrollView',
    Platform: { OS: 'ios', select: (v: any) => v.ios },
    useWindowDimensions: () => ({ width: 800, height: 600 }),
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => styles },
}));

vi.mock('@/sync/storage', () => ({
    useLocalSetting: () => false,
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('./views/_all', () => ({
    getToolFullViewComponent: () => null,
    getToolViewComponent: () => null,
}));

vi.mock('@/components/tools/knownTools', () => ({
    knownTools: {
        edit: { title: 'Edit' },
    },
}));

vi.mock('./views/StructuredResultView', () => ({
    StructuredResultView: () => null,
}));

vi.mock('./PermissionFooter', () => ({
    PermissionFooter: (props: any) => React.createElement('PermissionFooter', props),
}));

describe('ToolFullView (permission pending)', () => {
    it('renders PermissionFooter so users can approve/deny from the full view', async () => {
        const { ToolFullView } = await import('./ToolFullView');

        const tool: ToolCall = {
            name: 'edit',
            state: 'running',
            input: {},
            result: null,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: null,
            description: 'edit',
            permission: { id: 'perm1', status: 'pending' },
        };

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ToolFullView as any, { tool, metadata: null, messages: [], sessionId: 's1' }),
            );
        });

        expect(tree!.root.findAllByType('PermissionFooter' as any).length).toBe(1);
    });
});

