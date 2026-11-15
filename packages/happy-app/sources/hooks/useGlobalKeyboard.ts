import { useEffect } from 'react';
import { Platform } from 'react-native';

export function useGlobalKeyboard(
    onCommandPalette: (() => void) | undefined,
    options: {
        onOpenKeyboardShortcuts?: () => void;
        onOpenSettings?: () => void;
        onToggleLeftSidebar?: () => void;
        onToggleRightSidebar?: () => void;
    } = {},
) {
    useEffect(() => {
        if (Platform.OS !== 'web') {
            return;
        }

        const handleKeyDown = (e: KeyboardEvent) => {
            // Directly mounted applications own keys that originate in their root.
            // Do not mutate hidden Paws panels before their bubble handlers run.
            const localPath = e.composedPath?.().some(node => (node as Element)?.getAttribute?.('data-paws-shortcuts') === 'local');
            const localCanvas = typeof document !== 'undefined' && e.target === document.body && document.querySelector('[data-paws-shortcuts="local"]');
            if (localPath || localCanvas) return;
            if (e.isComposing || e.repeat) {
                return;
            }

            const isModifierPressed = e.metaKey || e.ctrlKey;
            const key = e.key.toLowerCase();
            const matchesKey = (character: string, code: string) => key === character || e.code === code;
            let handler: (() => void) | undefined;

            if (isModifierPressed && !e.altKey && matchesKey('p', 'KeyP')) {
                handler = onCommandPalette;
            } else if (isModifierPressed && !e.altKey && matchesKey(',', 'Comma')) {
                handler = options.onOpenSettings;
            } else if (isModifierPressed && !e.altKey && matchesKey('/', 'Slash')) {
                handler = options.onOpenKeyboardShortcuts;
            } else if (isModifierPressed && e.altKey && matchesKey('b', 'KeyB')) {
                handler = options.onToggleRightSidebar;
            } else if (isModifierPressed && !e.altKey && matchesKey('b', 'KeyB')) {
                handler = options.onToggleLeftSidebar;
            }

            if (handler) {
                e.preventDefault();
                e.stopPropagation();
                handler();
            }
        };

        // Capture before focused editors or embedded surfaces can stop bubbling.
        window.addEventListener('keydown', handleKeyDown, true);

        // Cleanup
        return () => {
            window.removeEventListener('keydown', handleKeyDown, true);
        };
    }, [onCommandPalette, options.onOpenKeyboardShortcuts, options.onOpenSettings, options.onToggleLeftSidebar, options.onToggleRightSidebar]);
}
