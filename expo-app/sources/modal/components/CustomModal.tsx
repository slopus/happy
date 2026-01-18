import React from 'react';
import { BaseModal } from './BaseModal';
import { CustomModalConfig } from '../types';
import { CommandPaletteModal } from '@/components/CommandPalette/CommandPaletteModal';
import { CommandPalette } from '@/components/CommandPalette';

interface CustomModalProps {
    config: CustomModalConfig;
    onClose: () => void;
}

type CommandPaletteExternalProps = Omit<React.ComponentProps<typeof CommandPalette>, 'onClose'>;

export function CustomModal({ config, onClose }: CustomModalProps) {
    const Component = config.component;
    
    // Use special modal wrapper for CommandPalette with animation support
    if (Component === CommandPalette) {
        return <CommandPaletteWithAnimation config={config} onClose={onClose} />;
    }

    const handleClose = React.useCallback(() => {
        // Allow custom modals to run cleanup/cancel logic when the modal is dismissed
        // (e.g. tapping the backdrop).
        // NOTE: props are user-defined; we intentionally check this dynamically.
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const maybe = (config.props as any)?.onRequestClose;
            if (typeof maybe === 'function') {
                maybe();
            }
        } catch {
            // ignore
        }
        onClose();
    }, [config.props, onClose]);
    
    return (
        <BaseModal visible={true} onClose={handleClose} closeOnBackdrop={config.closeOnBackdrop ?? true}>
            <Component {...config.props} onClose={handleClose} />
        </BaseModal>
    );
}

// Helper component to manage CommandPalette animation state
function CommandPaletteWithAnimation({ config, onClose }: CustomModalProps) {
    const [isClosing, setIsClosing] = React.useState(false);
    const commandPaletteProps = (config.props as CommandPaletteExternalProps | undefined) ?? { commands: [] };
    
    const handleClose = React.useCallback(() => {
        setIsClosing(true);
        // Wait for animation to complete before unmounting
        setTimeout(onClose, 200);
    }, [onClose]);
    
    return (
        <CommandPaletteModal visible={!isClosing} onClose={handleClose}>
            <CommandPalette {...commandPaletteProps} onClose={handleClose} />
        </CommandPaletteModal>
    );
}
