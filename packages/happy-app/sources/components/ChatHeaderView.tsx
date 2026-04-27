import * as React from 'react';
import { View, Text, StyleSheet, Platform, Pressable } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';
import { useHeaderHeight } from '@/utils/responsive';
import { layout } from '@/components/layout';
import { useUnistyles } from 'react-native-unistyles';

interface ChatHeaderViewProps {
    title: string;
    /** Project folder name (last path segment) */
    folderName?: string;
    onTitlePress?: () => void;
    backgroundColor?: string;
    tintColor?: string;
    isConnected?: boolean;
}

export const ChatHeaderView: React.FC<ChatHeaderViewProps> = ({
    title,
    folderName,
    onTitlePress,
    isConnected = true,
}) => {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();

    return (
        <View style={[styles.container, { paddingTop: insets.top, backgroundColor: theme.colors.header.background }]}>
            <View style={styles.contentWrapper}>
                <View style={[styles.content, { height: headerHeight }]}>
                    <Pressable
                        style={styles.titleContainer}
                        onPress={onTitlePress}
                        disabled={!onTitlePress}
                    >
                        {folderName ? (
                            <View style={styles.titleRow}>
                                <Octicons name="file-directory" size={14} color={theme.colors.textSecondary} />
                                <Text
                                    numberOfLines={1}
                                    style={[styles.folderName, { color: theme.colors.textSecondary, ...Typography.default() }]}
                                >
                                    {folderName}
                                </Text>
                                <Text style={[styles.separator, { color: theme.colors.textSecondary, ...Typography.default() }]}>/</Text>
                                <Text
                                    numberOfLines={1}
                                    ellipsizeMode="tail"
                                    style={[styles.title, { color: theme.colors.header.tint, ...Typography.default() }]}
                                >
                                    {title}
                                </Text>
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
    },
    title: {
        fontSize: 14,
        fontWeight: '600',
        flexShrink: 1,
    },
});
