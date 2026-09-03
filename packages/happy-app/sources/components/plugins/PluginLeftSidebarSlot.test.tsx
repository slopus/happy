import * as React from 'react';
import { act } from 'react';
import type { PluginCatalogItem } from '@slopus/happy-wire';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginLeftSidebarSlot } from './PluginLeftSidebarSlot';

// @ts-expect-error react-test-renderer is used through its small runtime surface.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    plugins: [] as PluginCatalogItem[],
}));

vi.mock('@/hooks/usePlugins', () => ({
    usePlugins: () => ({ plugins: mocks.plugins }),
}));
vi.mock('../relationship-advisor/RelationshipAdvisorSidebarHistory', () => ({
    RelationshipAdvisorSidebarHistory: 'RelationshipAdvisorSidebarHistory',
}));

function advisor(installed: boolean): PluginCatalogItem {
    return {
        manifest: {
            schemaVersion: 2,
            hostApiVersion: 1,
            id: 'relationship-advisor',
            version: '1.0.0',
            title: { default: 'Relationship Advisor' },
            description: { default: 'Relationship Advisor' },
            icon: 'chatbubbles-outline',
            featured: true,
            installedAction: 'configure',
            permissions: ['paws.ai.provider.invoke', 'paws.secrets.use'],
            entrypoint: { type: 'view', viewId: 'relationship-advisor.chat' },
            contributes: {
                views: [
                    { id: 'relationship-advisor.chat', surface: 'page', title: { default: 'Chat' } },
                    { id: 'relationship-advisor.history', surface: 'left-sidebar', title: { default: 'History' } },
                ],
            },
            configuration: { fields: [] },
        },
        status: installed
            ? {
                installed: true,
                version: '1.0.0',
                grantedPermissions: ['paws.ai.provider.invoke', 'paws.secrets.use'],
                configuration: {},
                secretHints: {},
            }
            : { installed: false },
    };
}

describe('PluginLeftSidebarSlot', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        mocks.plugins = [];
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => consoleErrorSpy.mockRestore());

    it('mounts and retracts the advisor history through installation state', () => {
        mocks.plugins = [advisor(true)];
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <PluginLeftSidebarSlot desktopDensity onNavigate={vi.fn()} />,
            );
        });
        expect(renderer.root.findAllByType('RelationshipAdvisorSidebarHistory')).toHaveLength(1);

        mocks.plugins = [advisor(false)];
        act(() => {
            renderer.update(<PluginLeftSidebarSlot desktopDensity onNavigate={vi.fn()} />);
        });
        expect(renderer.root.findAllByType('RelationshipAdvisorSidebarHistory')).toHaveLength(0);
        act(() => renderer.unmount());
    });
});
