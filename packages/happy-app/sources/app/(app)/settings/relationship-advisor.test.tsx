import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer does not publish declarations used by this narrow test.
import TestRenderer from 'react-test-renderer';

const replace = vi.hoisted(() => vi.fn());
vi.mock('expo-router', () => ({ useRouter: () => ({ replace }) }));
vi.mock('@/components/plugins/RelationshipAdvisorPluginConfiguration', () => ({
    RelationshipAdvisorPluginConfiguration: 'RelationshipAdvisorPluginConfiguration',
}));

import RelationshipAdvisorPluginSettingsScreen from './relationship-advisor';

describe('RelationshipAdvisorPluginSettingsScreen', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://dev/warnings/react-test-renderer') return;
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => consoleErrorSpy.mockRestore());

    it('opens the advisor after the dynamic plugin configuration installs it', () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<RelationshipAdvisorPluginSettingsScreen />); });

        act(() => renderer.root.findByType('RelationshipAdvisorPluginConfiguration').props.onInstalled());

        expect(replace).toHaveBeenCalledWith('/relationship-advisor');
        act(() => renderer.unmount());
    });
});
