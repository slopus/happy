import { ReactNode, ComponentType } from 'react';

export type ModalType = 'alert' | 'confirm' | 'custom';

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

export interface CustomModalConfig extends BaseModalConfig {
    type: 'custom';
    component: ComponentType<any>;
    props?: any;
}

export type ModalConfig = AlertModalConfig | ConfirmModalConfig | CustomModalConfig;

export interface ModalState {
    modals: ModalConfig[];
}

export interface ModalContextValue {
    state: ModalState;
    showModal: (config: Omit<ModalConfig, 'id'>) => string;
    hideModal: (id: string) => void;
    hideAllModals: () => void;
}