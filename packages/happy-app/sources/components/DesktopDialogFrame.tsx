import * as React from 'react';
import { Modal, Pressable, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

export function DesktopDialogFrame({ children, onClose, title, visible }: {
    children: React.ReactNode;
    onClose: () => void;
    title: string;
    visible: boolean;
}) {
    const { theme } = useUnistyles();
    return (
        <Modal animationType="fade" onRequestClose={onClose} transparent visible={visible}>
            <View style={styles.modalRoot}>
                <Pressable accessibilityElementsHidden onPress={onClose} style={styles.modalBackdrop} />
                <View accessibilityViewIsModal style={styles.dialog}>
                    <View style={styles.dialogHeader}>
                        <Text style={styles.dialogTitle}>{title}</Text>
                        <Pressable
                            accessibilityLabel={t('sidebarLists.close')}
                            onPress={onClose}
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
        maxWidth: 520,
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
