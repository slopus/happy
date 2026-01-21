import React from 'react';
import { BaseModal } from './BaseModal';
import { CustomModalConfig } from '../types';

interface CustomModalProps {
    config: CustomModalConfig;
    onClose: () => void;
    showBackdrop?: boolean;
    zIndexBase?: number;
}

export function CustomModal({ config, onClose, showBackdrop = true, zIndexBase }: CustomModalProps) {
    const Component = config.component;

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
        <BaseModal
            visible={true}
            onClose={handleClose}
            closeOnBackdrop={config.closeOnBackdrop ?? true}
            showBackdrop={showBackdrop}
            zIndexBase={zIndexBase}
        >
            <Component {...config.props} onClose={handleClose} />
        </BaseModal>
    );
}
