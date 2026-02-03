import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { ModalState, ModalConfig, ModalContextValue } from './types';
import { Modal } from './ModalManager';
import { WebAlertModal } from './components/WebAlertModal';
import { WebPromptModal } from './components/WebPromptModal';
import { CustomModal } from './components/CustomModal';

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

    const currentModal = state.modals[state.modals.length - 1];

    return (
        <ModalContext.Provider value={contextValue}>
            {children}
            {currentModal && (
                <>
                    {currentModal.type === 'alert' && (
                        <WebAlertModal
                            config={currentModal}
                            onClose={() => hideModal(currentModal.id)}
                        />
                    )}
                    {currentModal.type === 'confirm' && (
                        <WebAlertModal
                            config={currentModal}
                            onClose={() => hideModal(currentModal.id)}
                            onConfirm={(value) => {
                                Modal.resolveConfirm(currentModal.id, value);
                                hideModal(currentModal.id);
                            }}
                        />
                    )}
                    {currentModal.type === 'prompt' && (
                        <WebPromptModal
                            config={currentModal}
                            onClose={() => hideModal(currentModal.id)}
                            onConfirm={(value) => {
                                Modal.resolvePrompt(currentModal.id, value);
                                hideModal(currentModal.id);
                            }}
                        />
                    )}
                    {currentModal.type === 'custom' && (
                        <CustomModal
                            config={currentModal}
                            onClose={() => hideModal(currentModal.id)}
                        />
                    )}
                </>
            )}
        </ModalContext.Provider>
    );
}