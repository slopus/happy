// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { DesktopDialogFrame } from './DesktopDialogFrame';
const modal = vi.hoisted(() => ({ onShow: undefined as (() => void) | undefined }));
vi.mock('react-native', async () => {
    // @ts-expect-error RN Web runtime is installed without a declarations package.
    const web = await import('react-native-web');
    return { ...web, Modal: ({ onShow, children }: { onShow: () => void; children: React.ReactNode }) => { modal.onShow = onShow; return <>{children}</>; } };
});
vi.mock('react-native-unistyles', async () => {
    const { lightTheme } = await import('@/theme');
    return { useUnistyles: () => ({ theme: lightTheme }), StyleSheet: { hairlineWidth: 1, create: (factory: (theme: typeof lightTheme) => unknown) => factory(lightTheme) } };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@/components/StyledText', () => ({ Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock('@/text', () => ({ t: () => 'Close' }));

it.each([true, false])('respects focus acquired inside the dialog before its animation completes: %s', (inside) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    try {
        act(() => root.render(<DesktopDialogFrame visible title="Editor" onClose={() => {}}><input data-testid="draft" /></DesktopDialogFrame>));
        const input = host.querySelector<HTMLInputElement>('[data-testid="draft"]')!;
        if (inside) input.focus();
        act(() => modal.onShow?.());
        expect(document.activeElement).toBe(inside ? input : host.querySelector('[aria-label="Close"]'));
    } finally { act(() => root.unmount()); host.remove(); }
});
