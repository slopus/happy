import * as React from 'react';
import { View, Text, StyleSheet, Platform, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';
import { useHeaderHeight, useIsTablet } from '@/utils/responsive';
import { layout } from '@/components/layout';
import { useUnistyles } from 'react-native-unistyles';

interface ChatHeaderViewProps {
    title: string;
    /** Project folder name (last path segment) */
    folderName?: string;
    /** Extra path segment appended to the title with a separator (used for the file-view overlay). */
    extraPathSegment?: string;
    /** Optional content rendered at the right edge of the header (used by file-view / diff overlays). */
    rightSlot?: React.ReactNode;
    onTitlePress?: () => void;
    onBackPress?: () => void;
    backgroundColor?: string;
    tintColor?: string;
    isConnected?: boolean;
}

export const ChatHeaderView: React.FC<ChatHeaderViewProps> = ({
    title,
    folderName,
    extraPathSegment,
    rightSlot,
    onTitlePress,
    onBackPress,
    isConnected = true,
}) => {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const isTablet = useIsTablet();
    const showBackButton = !isTablet && !!onBackPress;
    const hasExtra = !!extraPathSegment;

    return (
        <View style={[styles.container, { paddingTop: insets.top, backgroundColor: theme.colors.header.background }]}>
            <View style={styles.contentWrapper}>
                <View style={[styles.content, { height: headerHeight }]}>
                    {showBackButton && (
                        <Pressable onPress={onBackPress} hitSlop={15} style={styles.backButton}>
                            <Ionicons
                                name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'}
                                size={24}
                                color={theme.colors.header.tint}
                            />
                        </Pressable>
                    )}
                    <Pressable
                        style={styles.titleContainer}
                        onPress={onTitlePress}
                        disabled={!onTitlePress}
                    >
                        {folderName ? (
                            <View style={styles.titleRow}>
                                <Text
                                    numberOfLines={1}
                                    style={[styles.folderName, { color: theme.colors.textSecondary, ...Typography.default() }]}
                                >
                                    {folderName}
                                </Text>
                                {title && title !== folderName && (
                                    <>
                                        <Text style={[styles.separator, { color: theme.colors.textSecondary, ...Typography.default() }]}>/</Text>
                                        <Text
                                            numberOfLines={1}
                                            ellipsizeMode="tail"
                                            style={[
                                                styles.title,
                                                hasExtra && styles.titleWithExtra,
                                                { color: theme.colors.header.tint, ...Typography.default() },
                                            ]}
                                        >
                                            {title}
                                        </Text>
                                    </>
                                )}
                                {hasExtra && (
                                    <>
                                        <Text style={[styles.separator, { color: theme.colors.textSecondary, ...Typography.default() }]}>/</Text>
                                        <Text
                                            numberOfLines={1}
                                            ellipsizeMode="middle"
                                            style={[styles.extraPath, { color: theme.colors.header.tint, ...Typography.mono() }]}
                                        >
                                            {extraPathSegment}
                                        </Text>
                                    </>
                                )}
                            </View>
                        ) : (
                            <Text
                                numberOfLines={1}
                                ellipsizeMode="tail"
                                style={[styles.title, { color: theme.colors.header.tint, ...Typography.default() }]}
                            >
                                {title}
                            </Text>
                        )}
                    </Pressable>
                    {rightSlot ? (
                        <View style={styles.rightSlot}>
                            {rightSlot}
                        </View>
                    ) : null}
                </View>
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        position: 'relative',
        zIndex: 100,
    },
    contentWrapper: {
        width: '100%',
        alignItems: 'center',
    },
    content: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: Platform.OS === 'ios' ? 8 : 16,
        width: '100%',
        maxWidth: layout.headerMaxWidth,
    },
    titleContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'flex-start',
        minWidth: 0,
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        width: '100%',
    },
    folderName: {
        fontSize: 14,
        flexShrink: 0,
    },
    separator: {
        fontSize: 14,
        flexShrink: 0,
    },
    title: {
        fontSize: 14,
        fontWeight: '600',
        flexShrink: 1,
    },
    titleWithExtra: {
        // When an extra path segment follows, let the chat name keep its
        // intrinsic width and squeeze the path first.
        flexShrink: 0.5,
    },
    extraPath: {
        flex: 1,
        minWidth: 0,
        fontSize: 13,
        flexShrink: 1,
    },
    rightSlot: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginLeft: 12,
        flexShrink: 0,
    },
    backButton: {
        paddingHorizontal: 8,
        paddingVertical: 4,
    },
});
