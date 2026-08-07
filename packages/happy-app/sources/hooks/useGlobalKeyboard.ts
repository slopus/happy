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
            if (e.isComposing || e.repeat) {
                return;
            }

            const isModifierPressed = e.metaKey || e.ctrlKey;
            const key = e.key.toLowerCase();
            let handler: (() => void) | undefined;

            if (isModifierPressed && !e.altKey && key === 'k') {
                handler = onCommandPalette;
            } else if (isModifierPressed && !e.altKey && key === ',') {
                handler = options.onOpenSettings;
            } else if (isModifierPressed && !e.altKey && key === '/') {
                handler = options.onOpenKeyboardShortcuts;
            } else if (isModifierPressed && e.altKey && key === 'b') {
                handler = options.onToggleRightSidebar;
            } else if (isModifierPressed && !e.altKey && key === 'b') {
                handler = options.onToggleLeftSidebar;
            }

            if (handler) {
                e.preventDefault();
                e.stopPropagation();
                handler();
            }
        };

        // Add event listener
        window.addEventListener('keydown', handleKeyDown);

        // Cleanup
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [onCommandPalette, options.onOpenKeyboardShortcuts, options.onOpenSettings, options.onToggleLeftSidebar, options.onToggleRightSidebar]);
}
