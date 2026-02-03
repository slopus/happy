import { useEffect } from 'react';
import { Platform } from 'react-native';

export function useGlobalKeyboard(onCommandPalette: () => void) {
    useEffect(() => {
        if (Platform.OS !== 'web') {
            return;
        }

        const handleKeyDown = (e: KeyboardEvent) => {
            // Check for CMD+K (Mac) or Ctrl+K (Windows/Linux)
            const isModifierPressed = e.metaKey || e.ctrlKey;
            
            if (isModifierPressed && e.key === 'k') {
                e.preventDefault();
                e.stopPropagation();
                onCommandPalette();
            }
        };

        // Add event listener
        window.addEventListener('keydown', handleKeyDown);

        // Cleanup
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [onCommandPalette]);
}