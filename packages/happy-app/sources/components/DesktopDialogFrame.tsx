import * as React from 'react';
import { Modal, Pressable, View, Platform } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

export function DesktopDialogFrame({ children, headerActions, maxWidth = 520, onClose, onDismiss, testID, title, visible }: {
    children: React.ReactNode;
    headerActions?: React.ReactNode;
    maxWidth?: number;
    onClose: () => void;
    onDismiss?: () => void;
    testID?: string;
    title: string;
    visible: boolean;
}) {
    const { theme } = useUnistyles();
    const closeButtonRef = React.useRef<any>(null);
    const dialogRef = React.useRef<View>(null);
    return (
        <Modal
            accessibilityLabel={title}
            animationType="fade"
            onRequestClose={onClose}
            onDismiss={onDismiss}
            onShow={() => {
                // The fade can finish after a user has already opened a picker.
                // Keep that focus so Escape still reaches the active child layer.
                if (Platform.OS === 'web' && typeof document !== 'undefined'
                    && (dialogRef.current as unknown as HTMLElement | null)?.contains(document.activeElement)) return;
                closeButtonRef.current?.focus?.();
            }}
            transparent
            visible={visible}
        >
            <View style={styles.modalRoot}>
                <View
                    accessible={false}
                    importantForAccessibility="no-hide-descendants"
                    onResponderRelease={onClose}
                    onStartShouldSetResponder={() => true}
                    style={styles.modalBackdrop}
                    testID="desktop-dialog-backdrop"
                />
                <View ref={dialogRef} accessibilityViewIsModal style={[styles.dialog, { maxWidth }]} testID={testID}>
                    <View style={styles.dialogHeader}>
                        <Text style={styles.dialogTitle}>{title}</Text>
                        {headerActions}
                        <Pressable
                            accessibilityLabel={t('sidebarLists.close')}
                            accessibilityRole="button"
                            onPress={onClose}
                            ref={closeButtonRef}
                            style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
                        >
                            <Feather color={theme.colors.textSecondary} name="x" size={18} />
                        </Pressable>
                    </View>
                    {children}
                </View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create((theme) => ({
    modalRoot: { alignItems: 'center', flex: 1, justifyContent: 'center', padding: 20 },
    modalBackdrop: { backgroundColor: theme.colors.shadow.color, bottom: 0, left: 0, opacity: 0.28, position: 'absolute', right: 0, top: 0 },
    dialog: {
        backgroundColor: theme.colors.surface,
        borderColor: theme.colors.divider,
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
        maxHeight: '86%',
        overflow: 'hidden',
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 10 },
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 24,
        width: '100%',
    },
    dialogHeader: { alignItems: 'center', borderBottomColor: theme.colors.divider, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', minHeight: 54, paddingHorizontal: 16 },
    dialogTitle: { color: theme.colors.text, flex: 1, fontSize: 17, ...Typography.default('semiBold') },
    iconButton: { alignItems: 'center', borderRadius: 7, height: 36, justifyContent: 'center', width: 36 },
    iconButtonPressed: { backgroundColor: theme.colors.surfacePressed },
}));
