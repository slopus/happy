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

export type CustomModalInjectedProps = Readonly<{
    onClose: () => void;
}>;

export interface CustomModalConfig<P extends CustomModalInjectedProps = any> extends BaseModalConfig {
    type: 'custom';
    component: ComponentType<P>;
    props?: Omit<P, keyof CustomModalInjectedProps>;
    /**
     * Whether tapping the backdrop should close the modal.
     * Defaults to true.
     */
    closeOnBackdrop?: boolean;
}

export type ModalConfig = AlertModalConfig | ConfirmModalConfig | PromptModalConfig | CustomModalConfig<any>;

export interface ModalState {
    modals: ModalConfig[];
}

export interface ModalContextValue {
    state: ModalState;
    showModal: (config: Omit<ModalConfig, 'id'>) => string;
    hideModal: (id: string) => void;
    hideAllModals: () => void;
}

export interface IModal {
    alert(title: string, message?: string, buttons?: AlertButton[]): void;
    confirm(title: string, message?: string, options?: {
        cancelText?: string;
        confirmText?: string;
        destructive?: boolean;
    }): Promise<boolean>;
    prompt(title: string, message?: string, options?: {
        placeholder?: string;
        defaultValue?: string;
        cancelText?: string;
        confirmText?: string;
        inputType?: 'default' | 'secure-text' | 'email-address' | 'numeric';
    }): Promise<string | null>;
    show<P extends CustomModalInjectedProps>(config: {
        component: ComponentType<P>;
        props?: Omit<P, keyof CustomModalInjectedProps>;
    }): string;
    hide(id: string): void;
    hideAll(): void;
}
