import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { ModalState, ModalConfig, ModalContextValue } from './types';
import { Modal } from './ModalManager';
import { WebAlertModal } from './components/WebAlertModal';
import { WebPromptModal } from './components/WebPromptModal';
import { CustomModal } from './components/CustomModal';
import { OverlayPortalHost, OverlayPortalProvider } from '@/components/ui/popover';

const ModalContext = createContext<ModalContextValue | undefined>(undefined);

export function useModal() {
    const context = useContext(ModalContext);
    if (!context) {
        throw new Error('useModal must be used within a ModalProvider');
    }
    return context;
}

export function ModalProvider({ children }: { children: React.ReactNode }) {
    const [state, setState] = useState<ModalState>({
        modals: []
    });

    const generateId = useCallback(() => {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }, []);

    const showModal = useCallback((config: Omit<ModalConfig, 'id'>): string => {
        const id = generateId();
        const modalConfig: ModalConfig = { ...config, id } as ModalConfig;
        
        setState(prev => ({
            modals: [...prev.modals, modalConfig]
        }));
        
        return id;
    }, [generateId]);

    const hideModal = useCallback((id: string) => {
        setState(prev => ({
            modals: prev.modals.filter(modal => modal.id !== id)
        }));
    }, []);

    const hideAllModals = useCallback(() => {
        setState({ modals: [] });
    }, []);

    // Initialize ModalManager with functions
    useEffect(() => {
        Modal.setFunctions(showModal, hideModal, hideAllModals);
    }, [showModal, hideModal, hideAllModals]);

    const contextValue: ModalContextValue = {
        state,
        showModal,
        hideModal,
        hideAllModals
    };

    const topIndex = state.modals.length - 1;
    const zIndexStep = 10;
    const zIndexBase = 100000;

    return (
        <OverlayPortalProvider>
            <ModalContext.Provider value={contextValue}>
                {children}
                {state.modals.map((modal, index) => {
                    const showBackdrop = index === topIndex;
                    const modalZIndexBase = zIndexBase + index * zIndexStep;

                    if (modal.type === 'alert') {
                        return (
                            <WebAlertModal
                                key={modal.id}
                                config={modal}
                                onClose={() => hideModal(modal.id)}
                                showBackdrop={showBackdrop}
                                zIndexBase={modalZIndexBase}
                            />
                        );
                    }

                    if (modal.type === 'confirm') {
                        return (
                            <WebAlertModal
                                key={modal.id}
                                config={modal}
                                onClose={() => hideModal(modal.id)}
                                onConfirm={(value) => {
                                    Modal.resolveConfirm(modal.id, value);
                                    hideModal(modal.id);
                                }}
                                showBackdrop={showBackdrop}
                                zIndexBase={modalZIndexBase}
                            />
                        );
                    }

                    if (modal.type === 'prompt') {
                        return (
                            <WebPromptModal
                                key={modal.id}
                                config={modal}
                                onClose={() => hideModal(modal.id)}
                                onConfirm={(value) => {
                                    Modal.resolvePrompt(modal.id, value);
                                    hideModal(modal.id);
                                }}
                                showBackdrop={showBackdrop}
                                zIndexBase={modalZIndexBase}
                            />
                        );
                    }

                    if (modal.type === 'custom') {
                        return (
                            <CustomModal
                                key={modal.id}
                                config={modal}
                                onClose={() => hideModal(modal.id)}
                                showBackdrop={showBackdrop}
                                zIndexBase={modalZIndexBase}
                            />
                        );
                    }

                    return null;
                })}
                <OverlayPortalHost />
            </ModalContext.Provider>
        </OverlayPortalProvider>
    );
}
