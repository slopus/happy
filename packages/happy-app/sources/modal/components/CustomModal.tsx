import React from 'react';
import { Platform } from 'react-native';
import { BaseModal } from './BaseModal';
import { CustomModalConfig } from '../types';
import { CommandPaletteModal } from '@/components/CommandPalette/CommandPaletteModal';
import { CommandPalette } from '@/components/CommandPalette';
import type { CommandPaletteClose } from '@/components/CommandPalette/types';

interface CustomModalProps {
    config: CustomModalConfig;
    onClose: () => void;
}

export function CustomModal({ config, onClose }: CustomModalProps) {
    const Component = config.component;
    
    // Use special modal wrapper for CommandPalette with animation support
    if (Component === CommandPalette) {
        return <CommandPaletteWithAnimation config={config} onClose={onClose} />;
    }
    
    return (
        <BaseModal visible={true} onClose={onClose}>
            <Component {...config.props} onClose={onClose} />
        </BaseModal>
    );
}

// Helper component to manage CommandPalette animation state
function CommandPaletteWithAnimation({ config, onClose }: CustomModalProps) {
    const [isClosing, setIsClosing] = React.useState(false);
    const isClosingRef = React.useRef(false);
    const afterCloseRef = React.useRef<(() => void) | undefined>(undefined);

    React.useEffect(() => () => {
        const afterClose = afterCloseRef.current;
        afterCloseRef.current = undefined;
        if (afterClose) {
            // The provider has committed the modal removal by the time this
            // cleanup runs. Use the next task so RN Web can finish restoring
            // focus before navigation or another modal begins.
            setTimeout(afterClose, 0);
        }
    }, []);
    
    const handleClose = React.useCallback<CommandPaletteClose>((afterClose) => {
        if (isClosingRef.current) {
            return;
        }

        isClosingRef.current = true;
        afterCloseRef.current = afterClose;
        setIsClosing(true);
        if (Platform.OS === 'web') {
            // Keyboard-driven surfaces should disappear in the same task. The
            // command itself still runs after provider cleanup, preserving the
            // focus-restoration ordering without adding perceptible latency.
            onClose();
            return;
        }
        // Wait for animation to complete before unmounting
        setTimeout(onClose, 200);
    }, [onClose]);
    
    return (
        <CommandPaletteModal visible={!isClosing} onClose={onClose}>
            <CommandPalette {...config.props} onClose={handleClose} />
        </CommandPaletteModal>
    );
}
