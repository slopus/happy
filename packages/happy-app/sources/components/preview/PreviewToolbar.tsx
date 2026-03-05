import * as React from 'react';
import { View, TextInput, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

interface PreviewToolbarProps {
    url: string;
    onUrlChange: (url: string) => void;
    onUrlSubmit: () => void;
    inspectMode: boolean;
    onToggleInspect: () => void;
    deviceBarVisible: boolean;
    onToggleDeviceBar: () => void;
    onScreenshot?: () => void;
    screenshotLoading?: boolean;
    onPopOut?: () => void;
    onCopyLink?: () => void;
    onRefresh: () => void;
    onClose: () => void;
}

export const PreviewToolbar = React.memo(({
    url,
    onUrlChange,
    onUrlSubmit,
    inspectMode,
    onToggleInspect,
    deviceBarVisible,
    onToggleDeviceBar,
    onScreenshot,
    screenshotLoading,
    onPopOut,
    onCopyLink,
    onRefresh,
    onClose,
}: PreviewToolbarProps) => {
    const { theme } = useUnistyles();

    return (
        <View style={styles.container}>
            {/* Close button */}
            <Pressable onPress={onClose} hitSlop={6}>
                <Ionicons
                    name="close-outline"
                    size={20}
                    color={theme.colors.textSecondary}
                />
            </Pressable>

            {/* URL input */}
            <TextInput
                style={[
                    styles.urlInput,
                    {
                        backgroundColor: theme.colors.groupped.background,
                        color: theme.colors.text,
                    },
                ]}
                value={url}
                onChangeText={onUrlChange}
                onSubmitEditing={onUrlSubmit}
                placeholder="http://localhost:3000"
                placeholderTextColor={theme.colors.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                returnKeyType="go"
                selectTextOnFocus
            />

            {/* Inspect mode toggle */}
            <Pressable onPress={onToggleInspect} hitSlop={6}>
                <Ionicons
                    name="scan-outline"
                    size={18}
                    color={inspectMode
                        ? theme.colors.button.primary.background
                        : theme.colors.textSecondary
                    }
                />
            </Pressable>

            {/* Device bar toggle */}
            <Pressable onPress={onToggleDeviceBar} hitSlop={6}>
                <Ionicons
                    name="phone-portrait-outline"
                    size={18}
                    color={deviceBarVisible
                        ? theme.colors.button.primary.background
                        : theme.colors.textSecondary
                    }
                />
            </Pressable>

            {/* Screenshot to chat */}
            {onScreenshot && (
                <Pressable onPress={onScreenshot} hitSlop={6} disabled={screenshotLoading}>
                    <Ionicons
                        name={screenshotLoading ? 'hourglass-outline' : 'camera-outline'}
                        size={18}
                        color={screenshotLoading
                            ? theme.colors.button.primary.background
                            : theme.colors.textSecondary
                        }
                    />
                </Pressable>
            )}

            {/* Copy monitor link */}
            {onCopyLink && (
                <Pressable onPress={onCopyLink} hitSlop={6}>
                    <Ionicons
                        name="link-outline"
                        size={18}
                        color={theme.colors.textSecondary}
                    />
                </Pressable>
            )}

            {/* Pop out to external window */}
            {onPopOut && (
                <Pressable onPress={onPopOut} hitSlop={6}>
                    <Ionicons
                        name="open-outline"
                        size={18}
                        color={theme.colors.textSecondary}
                    />
                </Pressable>
            )}

            {/* Refresh button */}
            <Pressable onPress={onRefresh} hitSlop={6}>
                <Ionicons
                    name="refresh-outline"
                    size={18}
                    color={theme.colors.textSecondary}
                />
            </Pressable>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        height: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 10,
        backgroundColor: theme.colors.surface,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    urlInput: {
        flex: 1,
        borderRadius: 8,
        height: 32,
        fontSize: 13,
        ...Typography.mono(),
        paddingHorizontal: 10,
    },
}));
