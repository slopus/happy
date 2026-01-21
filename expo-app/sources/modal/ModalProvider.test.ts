import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('./components/WebAlertModal', () => ({
    WebAlertModal: () => null,
}));

vi.mock('./components/WebPromptModal', () => ({
    WebPromptModal: () => null,
}));

vi.mock('./components/CustomModal', () => {
    const React = require('react');
    return {
        CustomModal: ({ config, onClose, showBackdrop, zIndexBase }: any) =>
            React.createElement(
                React.Fragment,
                null,
                React.createElement('Backdrop', { showBackdrop, zIndexBase }),
                React.createElement(config.component, { ...(config.props ?? {}), onClose }),
            ),
    };
});

function DummyModalA(_props: { onClose: () => void }) {
    return React.createElement('DummyModalA');
}

function DummyModalB(_props: { onClose: () => void }) {
    return React.createElement('DummyModalB');
}

describe('ModalProvider', () => {
    afterEach(async () => {
        const { Modal } = await import('./ModalManager');
        Modal.setFunctions(() => 'noop', () => {}, () => {});
    });

    it('keeps earlier custom modals mounted when stacking', async () => {
        const { ModalProvider } = await import('./ModalProvider');
        const { Modal } = await import('./ModalManager');

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(React.createElement(ModalProvider, { children: React.createElement('App') }));
        });

        act(() => {
            Modal.show({ component: DummyModalA });
        });
        act(() => {
            Modal.show({ component: DummyModalB });
        });

        expect(tree?.root.findAllByType(DummyModalA).length).toBe(1);
        expect(tree?.root.findAllByType(DummyModalB).length).toBe(1);
    });

    it('only enables the backdrop on the top-most modal', async () => {
        const { ModalProvider } = await import('./ModalProvider');
        const { Modal } = await import('./ModalManager');

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(React.createElement(ModalProvider, { children: React.createElement('App') }));
        });

        act(() => {
            Modal.show({ component: DummyModalA });
        });
        act(() => {
            Modal.show({ component: DummyModalB });
        });

        const backdrops = tree?.root.findAllByType('Backdrop' as any) ?? [];
        expect(backdrops.filter((b: any) => Boolean(b.props.showBackdrop)).length).toBe(1);
    });

    it('assigns a higher zIndexBase to the top-most modal so its backdrop layers above earlier modals', async () => {
        const { ModalProvider } = await import('./ModalProvider');
        const { Modal } = await import('./ModalManager');

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(React.createElement(ModalProvider, { children: React.createElement('App') }));
        });

        act(() => {
            Modal.show({ component: DummyModalA });
        });
        act(() => {
            Modal.show({ component: DummyModalB });
        });

        const backdrops = tree?.root.findAllByType('Backdrop' as any) ?? [];
        const top = backdrops.find((b: any) => Boolean(b.props.showBackdrop));
        const bottom = backdrops.find((b: any) => !Boolean(b.props.showBackdrop));

        expect(top).toBeDefined();
        expect(bottom).toBeDefined();
        expect(typeof top?.props.zIndexBase).toBe('number');
        expect(typeof bottom?.props.zIndexBase).toBe('number');
        expect(top?.props.zIndexBase).toBeGreaterThan(bottom?.props.zIndexBase);
    });
});
