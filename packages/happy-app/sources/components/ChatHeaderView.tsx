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
    /**
     * Replaces the breadcrumb title region entirely with custom content (e.g. the
     * session chip). When set, the title text / folder breadcrumb and onTitlePress
     * are ignored — the slot handles its own press behaviour.
     */
    titleSlot?: React.ReactNode;
    /** Replaces the ☰ / back buttons on the left edge (e.g. a themed "enter space" button). */
    leftSlot?: React.ReactNode;
    /** Optional content rendered at the right edge of the header (used by file-view / diff overlays). */
    rightSlot?: React.ReactNode;
    onTitlePress?: () => void;
    onBackPress?: () => void;
    /** Opens the session-list drawer. Shown as a ☰ button left of the back arrow on phones. */
    onListPress?: () => void;
    backgroundColor?: string;
    tintColor?: string;
    isConnected?: boolean;
    /** Keeps the title clear of the desktop Zen/back/forward overlay. */
    headerContentLeftInset?: number;
}

export const ChatHeaderView: React.FC<ChatHeaderViewProps> = ({
    title,
    folderName,
    extraPathSegment,
    titleSlot,
    leftSlot,
    rightSlot,
    onTitlePress,
    onBackPress,
    onListPress,
    backgroundColor,
    tintColor,
    isConnected = true,
    headerContentLeftInset = 0,
}) => {
    const { theme } = useUnistyles();
    // 「空间皮肤」会话顶栏时，由调用方传入 accent 底色 + 白色 tint；缺省回退到主题默认。
    const headerBg = backgroundColor ?? theme.colors.header.background;
    const headerTint = tintColor ?? theme.colors.header.tint;
    const insets = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const isTablet = useIsTablet();
    const showBackButton = !isTablet && !!onBackPress;
    // The session-list drawer only exists on phones (tablet keeps a permanent
    // sidebar), so mirror the back button's phone-only visibility.
    const showListButton = !isTablet && !!onListPress;
    const hasExtra = !!extraPathSegment;

    return (
        <View style={[styles.container, { paddingTop: insets.top, backgroundColor: headerBg }]}>
            <View style={styles.contentWrapper}>
                <View
                    style={[
                        styles.content,
                        {
                            height: headerHeight,
                            paddingLeft: (Platform.OS === 'ios' ? 8 : 16) + headerContentLeftInset,
                        },
                    ]}
                >
                    {leftSlot ? leftSlot : (
                        <>
                            {showListButton && (
                                <Pressable onPress={onListPress} hitSlop={15} style={styles.listButton}>
                                    <Ionicons
                                        name="menu-outline"
                                        size={26}
                                        color={headerTint}
                                    />
                                </Pressable>
                            )}
                            {showBackButton && (
                                <Pressable onPress={onBackPress} hitSlop={15} style={styles.backButton}>
                                    <Ionicons
                                        name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'}
                                        size={24}
                                        color={headerTint}
                                    />
                                </Pressable>
                            )}
                        </>
                    )}
                    {titleSlot ? (
                        <View style={styles.titleContainer}>
                            {titleSlot}
                        </View>
                    ) : (
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
                                                { color: headerTint, ...Typography.default() },
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
                                            style={[styles.extraPath, { color: headerTint, ...Typography.mono() }]}
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
                                style={[styles.title, { color: headerTint, ...Typography.default() }]}
                            >
                                {title}
                            </Text>
                        )}
                    </Pressable>
                    )}
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
    listButton: {
        paddingHorizontal: 8,
        paddingVertical: 4,
    },
});
