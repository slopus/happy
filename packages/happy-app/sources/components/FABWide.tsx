import * as React from 'react';
import { View, Pressable, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        position: 'absolute',
        left: 12,
        right: 12,
        flexDirection: 'row',
        gap: 8,
    },
    button: {
        flex: 1,
        borderRadius: 12,
        paddingVertical: 14,
        paddingHorizontal: 12,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: 6,
        backgroundColor: theme.colors.groupped.item,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    buttonPressed: {
        backgroundColor: theme.colors.groupped.itemPressed,
    },
    text: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.text,
    },
}));

interface FABWideProps {
    onFilesPress: () => void;
    onSessionFilesPress?: () => void;
}

export const FABWide = React.memo(({ onFilesPress, onSessionFilesPress }: FABWideProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();

    return (
        <View
            style={[
                styles.container,
                { bottom: safeArea.bottom + 16 }
            ]}
        >
            <Pressable
                style={({ pressed }) => [
                    styles.button,
                    pressed && styles.buttonPressed
                ]}
                onPress={onFilesPress}
            >
                <Ionicons name="folder-outline" size={18} color={theme.colors.text} />
                <Text style={styles.text}>{t('tabs.files')}</Text>
            </Pressable>
            {onSessionFilesPress && (
                <Pressable
                    style={({ pressed }) => [
                        styles.button,
                        pressed && styles.buttonPressed
                    ]}
                    onPress={onSessionFilesPress}
                >
                    <Ionicons name="code-slash-outline" size={18} color={theme.colors.text} />
                    <Text style={styles.text}>{t('tabs.code')}</Text>
                </Pressable>
            )}
        </View>
    );
});
