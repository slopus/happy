import * as React from 'react';
import { Platform } from 'react-native';
import { useDesktopWorkspaceLayout } from '@/hooks/useDesktopWorkspaceLayout';
import { useGlobalKeyboard } from '@/hooks/useGlobalKeyboard';
import { useModal } from '@/modal';
import type { CustomModalConfig } from '@/modal/types';
import { useSetting } from '@/sync/storage';
import { t } from '@/text';
import { isTauri } from '@/utils/isTauri';

import { KeyboardShortcutsModal } from './KeyboardShortcutsModal';
import { createShortcutSections } from './shortcutCatalog';

export type KeyboardShortcutsLauncher = {
    isAvailable: boolean;
    open: () => void;
};

const KeyboardShortcutsLauncherContext = React.createContext<KeyboardShortcutsLauncher | null>(null);

export function useKeyboardShortcutsLauncher(): KeyboardShortcutsLauncher | null {
    return React.useContext(KeyboardShortcutsLauncherContext);
}

function getBrowserPlatform(): string {
    if (typeof navigator === 'undefined') return '';
    return (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
        ?? navigator.platform;
}

export function KeyboardShortcutsProvider({ children }: { children: React.ReactNode }) {
    const { state: modalState, showModal } = useModal();
    const shortcutsOpeningRef = React.useRef(false);
    const enterToSend = useSetting('agentInputEnterToSend');
    const { enabled, rightPanelAvailable } = useDesktopWorkspaceLayout();
    const shortcutsAreOpen = modalState.modals.some((modal) => (
        modal.type === 'custom' && modal.component === KeyboardShortcutsModal
    ));

    React.useEffect(() => {
        shortcutsOpeningRef.current = shortcutsAreOpen;
    }, [shortcutsAreOpen]);

    const open = React.useCallback(() => {
        if (Platform.OS !== 'web' || !enabled || shortcutsOpeningRef.current) return;

        shortcutsOpeningRef.current = true;
        const sections = createShortcutSections({
            enterToSend,
            inTauri: isTauri(),
            platform: getBrowserPlatform(),
            rightPanelAvailable,
        });
        showModal({
            type: 'custom',
            component: KeyboardShortcutsModal,
            accessibilityLabel: t('keyboardShortcuts.title'),
            props: { sections },
        } as Omit<CustomModalConfig, 'id'>);
    }, [enabled, enterToSend, rightPanelAvailable, showModal]);

    useGlobalKeyboard(undefined, { onOpenKeyboardShortcuts: enabled ? open : undefined });

    const launcher = React.useMemo<KeyboardShortcutsLauncher>(() => ({
        isAvailable: Platform.OS === 'web' && enabled,
        open,
    }), [enabled, open]);

    return (
        <KeyboardShortcutsLauncherContext.Provider value={launcher}>
            {children}
        </KeyboardShortcutsLauncherContext.Provider>
    );
}
