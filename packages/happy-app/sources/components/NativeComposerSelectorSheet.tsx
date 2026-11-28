import * as React from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';

/** Native selectors follow their own window, never a coordinate measured before the IME closed. */
export function NativeComposerSelectorSheet({ open, onClose, scrimTestID, children }: React.PropsWithChildren<{
    open: boolean;
    onClose: () => void;
    scrimTestID: string;
}>) {
    const insets = useSafeAreaInsets();
    return <Modal visible={open} transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.root}>
            <Pressable testID={scrimTestID} style={styles.scrim} onPress={onClose} />
            <View pointerEvents="box-none" style={[styles.content, {
                paddingTop: Math.max(12, insets.top), paddingBottom: Math.max(12, insets.bottom),
                paddingLeft: Math.max(12, insets.left), paddingRight: Math.max(12, insets.right),
            }]}>
                {children}
            </View>
        </KeyboardAvoidingView>
    </Modal>;
}

const styles = StyleSheet.create(() => ({
    root: { flex: 1 },
    scrim: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
    content: { flex: 1, justifyContent: 'flex-end', alignItems: 'center' },
}));
