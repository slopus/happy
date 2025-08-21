import { ReactNode, ComponentType } from 'react';

export type ModalType = 'alert' | 'confirm' | 'prompt' | 'custom';

export interface AlertButton {
    text: string;
    onPress?: () => void;
    style?: 'default' | 'cancel' | 'destructive';
}

export interface BaseModalConfig {
    id: string;
    type: ModalType;
}

export interface AlertModalConfig extends BaseModalConfig {
    type: 'alert';
    title: string;
    message?: string;
    buttons?: AlertButton[];
}

export interface ConfirmModalConfig extends BaseModalConfig {
    type: 'confirm';
    title: string;
    message?: string;
    cancelText?: string;
    confirmText?: string;
    destructive?: boolean;
}

export interface PromptModalConfig extends BaseModalConfig {
    type: 'prompt';
    title: string;
    message?: string;
    placeholder?: string;
    defaultValue?: string;
    cancelText?: string;
    confirmText?: string;
    inputType?: 'default' | 'secure-text' | 'email-address' | 'numeric';
}

export interface CustomModalConfig extends BaseModalConfig {
    type: 'custom';
    component: ComponentType<any>;
    props?: any;
}

export type ModalConfig = AlertModalConfig | ConfirmModalConfig | PromptModalConfig | CustomModalConfig;

export interface ModalState {
    modals: ModalConfig[];
}

export interface ModalContextValue {
    state: ModalState;
    showModal: (config: Omit<ModalConfig, 'id'>) => string;
    hideModal: (id: string) => void;
    hideAllModals: () => void;
}