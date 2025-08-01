import { Platform, Alert } from 'react-native';
import { AlertButton, ModalConfig, CustomModalConfig } from './types';

class ModalManagerClass {
    private showModalFn: ((config: Omit<ModalConfig, 'id'>) => string) | null = null;
    private hideModalFn: ((id: string) => void) | null = null;
    private hideAllModalsFn: (() => void) | null = null;
    private confirmResolvers: Map<string, (value: boolean) => void> = new Map();

    setFunctions(
        showModal: (config: Omit<ModalConfig, 'id'>) => string,
        hideModal: (id: string) => void,
        hideAllModals: () => void
    ) {
        this.showModalFn = showModal;
        this.hideModalFn = hideModal;
        this.hideAllModalsFn = hideAllModals;
    }

    private generateId(): string {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }

    alert(title: string, message?: string, buttons?: AlertButton[]): void {
        if (Platform.OS === 'web') {
            // Show custom web modal
            if (!this.showModalFn) {
                console.error('ModalManager not initialized. Make sure ModalProvider is mounted.');
                return;
            }

            this.showModalFn({
                type: 'alert',
                title,
                message,
                buttons: buttons || [{ text: 'OK' }]
            } as Omit<ModalConfig, 'id'>);
        } else {
            // Use native alert
            Alert.alert(title, message, buttons);
        }
    }

    async confirm(
        title: string,
        message?: string,
        options?: {
            cancelText?: string;
            confirmText?: string;
            destructive?: boolean;
        }
    ): Promise<boolean> {
        if (Platform.OS === 'web') {
            // Show custom web modal
            if (!this.showModalFn) {
                console.error('ModalManager not initialized. Make sure ModalProvider is mounted.');
                return false;
            }

            const modalId = this.showModalFn({
                type: 'confirm',
                title,
                message,
                cancelText: options?.cancelText,
                confirmText: options?.confirmText,
                destructive: options?.destructive
            } as Omit<ModalConfig, 'id'>);

            return new Promise<boolean>((resolve) => {
                this.confirmResolvers.set(modalId, resolve);
            });
        } else {
            // Use native alert
            return new Promise<boolean>((resolve) => {
                Alert.alert(
                    title,
                    message,
                    [
                        {
                            text: options?.cancelText || 'Cancel',
                            style: 'cancel',
                            onPress: () => resolve(false)
                        },
                        {
                            text: options?.confirmText || 'OK',
                            style: options?.destructive ? 'destructive' : 'default',
                            onPress: () => resolve(true)
                        }
                    ],
                    { cancelable: false }
                );
            });
        }
    }

    show(config: Omit<CustomModalConfig, 'id' | 'type'>): string {
        if (!this.showModalFn) {
            console.error('ModalManager not initialized. Make sure ModalProvider is mounted.');
            return '';
        }

        return this.showModalFn({
            ...config,
            type: 'custom'
        });
    }

    hide(id: string): void {
        if (!this.hideModalFn) {
            console.error('ModalManager not initialized. Make sure ModalProvider is mounted.');
            return;
        }

        this.hideModalFn(id);
    }

    hideAll(): void {
        if (!this.hideAllModalsFn) {
            console.error('ModalManager not initialized. Make sure ModalProvider is mounted.');
            return;
        }

        this.hideAllModalsFn();
    }

    resolveConfirm(id: string, value: boolean): void {
        const resolver = this.confirmResolvers.get(id);
        if (resolver) {
            resolver(value);
            this.confirmResolvers.delete(id);
        }
    }
}

export const Modal = new ModalManagerClass();