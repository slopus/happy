import React from 'react';
import { Platform, Alert } from 'react-native';
import { t } from '@/text';
import { Modal } from '@/modal';

interface PresetMessageEditModalProps {
    visible: boolean;
    onClose: () => void;
    onSave: (text: string) => void;
    onDelete?: () => void;
    initialText?: string;
    isNew?: boolean;
}

// Type definition for Alert.prompt buttons (iOS only)
interface AlertButton {
    text: string;
    style?: 'default' | 'cancel' | 'destructive';
    onPress?: ((text?: string) => void) | (() => void);
}

// Type for the iOS-only Alert.prompt function
type AlertPromptType = (
    title: string,
    message?: string,
    buttons?: AlertButton[],
    type?: 'plain-text' | 'secure-text',
    defaultValue?: string
) => void;

export const PresetMessageEditModal = React.memo(({
    visible,
    onClose,
    onSave,
    onDelete,
    initialText = '',
    isNew = false,
}: PresetMessageEditModalProps) => {
    const wasVisible = React.useRef(false);
    const paramsRef = React.useRef({ isNew, initialText, onSave, onDelete, onClose });

    // Update params ref
    paramsRef.current = { isNew, initialText, onSave, onDelete, onClose };

    React.useEffect(() => {
        if (visible && !wasVisible.current) {
            wasVisible.current = true;

            const { isNew, initialText, onSave, onDelete, onClose } = paramsRef.current;

            if (Platform.OS === 'ios' && 'prompt' in Alert) {
                // iOS: Use native Alert.prompt with multiple buttons
                // Type assertion is safe here because we checked for the prompt property at runtime
                const prompt = (Alert as { prompt: AlertPromptType }).prompt;

                const buttons: AlertButton[] = isNew
                    ? [
                        // Add new: Cancel / Save
                        {
                            text: t('common.cancel'),
                            style: 'cancel',
                            onPress: onClose
                        },
                        {
                            text: t('common.save'),
                            onPress: (text?: string) => {
                                if (text?.trim()) {
                                    onSave(text.trim());
                                }
                            }
                        }
                    ]
                    : [
                        // Edit existing: Cancel / Delete / Save
                        {
                            text: t('common.cancel'),
                            style: 'cancel',
                            onPress: onClose
                        }
                    ];

                if (!isNew && onDelete) {
                    buttons.push({
                        text: t('common.delete'),
                        style: 'destructive',
                        onPress: () => {
                            onDelete();
                            onClose();
                        }
                    });
                }

                if (!isNew) {
                    buttons.push({
                        text: t('common.save'),
                        onPress: (text?: string) => {
                            if (text?.trim()) {
                                onSave(text.trim());
                            }
                        }
                    });
                }

                prompt(
                    isNew ? t('presetMessages.addTitle') : t('presetMessages.editTitle'),
                    t('presetMessages.messagePlaceholder'),
                    buttons,
                    'plain-text',
                    initialText
                );
            } else {
                // Android/Web: Show prompt with delete button for editing existing
                Modal.prompt(
                    isNew ? t('presetMessages.addTitle') : t('presetMessages.editTitle'),
                    t('presetMessages.messagePlaceholder'),
                    {
                        placeholder: t('presetMessages.messagePlaceholder'),
                        defaultValue: initialText,
                        confirmText: t('common.save'),
                        cancelText: t('common.cancel'),
                        destructiveText: !isNew && onDelete ? t('common.delete') : undefined,
                    }
                ).then((text) => {
                    if (text === '__DELETE__') {
                        // Delete button was clicked
                        onDelete?.();
                    } else if (text?.trim()) {
                        onSave(text.trim());
                    }
                    onClose();
                }).catch(() => {
                    onClose();
                });
            }
        } else if (!visible) {
            wasVisible.current = false;
        }
    }, [visible]);

    return null;
});

PresetMessageEditModal.displayName = 'PresetMessageEditModal';
