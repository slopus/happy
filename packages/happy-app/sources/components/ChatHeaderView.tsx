import * as React from 'react';
import { View, Text, StyleSheet, Platform, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { Avatar } from '@/components/Avatar';
import { Typography } from '@/constants/Typography';
import { useHeaderHeight, useIsTablet } from '@/utils/responsive';
import { layout } from '@/components/layout';
import { useUnistyles } from 'react-native-unistyles';
import { useSidebarCollapse, useContentMaxWidth } from '@/components/SidebarNavigator';

interface ChatHeaderViewProps {
    title: string;
    subtitle?: string;
    onBackPress?: () => void;
    onAvatarPress?: () => void;
    avatarId?: string;
    backgroundColor?: string;
    tintColor?: string;
    isConnected?: boolean;
    flavor?: string | null;
    presetEmoji?: string;
    onPresetPress?: () => void;
    onSettingsPress?: () => void;
}

export const ChatHeaderView: React.FC<ChatHeaderViewProps> = ({
    title,
    subtitle,
    onBackPress,
    onAvatarPress,
    avatarId,
    isConnected = true,
    flavor,
    presetEmoji,
    onPresetPress,
    onSettingsPress,
}) => {
    const { theme } = useUnistyles();
    const navigation = useNavigation();
    const insets = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const isTablet = useIsTablet();
    const { collapsed: sidebarCollapsed, toggle: toggleSidebar } = useSidebarCollapse();
    const expandedMaxWidth = useContentMaxWidth();

    const handleBackPress = () => {
        if (onBackPress) {
            onBackPress();
        } else {
            navigation.goBack();
        }
    };

    return (
        <View style={[styles.container, { paddingTop: insets.top, backgroundColor: theme.colors.header.background }]}>
            <View style={styles.contentWrapper}>
                <View style={[styles.content, { height: headerHeight, maxWidth: expandedMaxWidth || layout.maxWidth }]}>
                {onSettingsPress && (
                    <Pressable
                        onPress={onSettingsPress}
                        hitSlop={10}
                        style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}
                    >
                        <Ionicons name="folder-outline" size={20} color={theme.colors.header.tint} style={{ opacity: 0.6 }} />
                    </Pressable>
                )}
                {Platform.OS === 'web' && isTablet && (
                    <Pressable
                        onPress={toggleSidebar}
                        hitSlop={10}
                        style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}
                    >
                        <Ionicons name={sidebarCollapsed ? "contract-outline" : "expand-outline"} size={18} color={theme.colors.header.tint} style={{ opacity: 0.6 }} />
                    </Pressable>
                )}

                <Pressable onPress={handleBackPress} style={styles.backButton} hitSlop={15}>
                    <Ionicons
                        name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'}
                        size={Platform.select({ ios: 28, default: 24 })}
                        color={theme.colors.header.tint}
                    />
                </Pressable>

                <View style={styles.titleContainer}>
                    <Text
                        numberOfLines={1}
                        ellipsizeMode="tail"
                        style={[
                            styles.title,
                            {
                                color: theme.colors.header.tint,
                                ...Typography.default('semiBold')
                            }
                        ]}
                    >
                        {title}
                    </Text>
                    {subtitle && (
                        <Text
                            numberOfLines={1}
                            ellipsizeMode="tail"
                            style={[
                                styles.subtitle,
                                {
                                    color: theme.colors.header.tint,
                                    opacity: 0.7,
                                    ...Typography.default()
                                }
                            ]}
                        >
                            {subtitle}
                        </Text>
                    )}
                </View>

                {onPresetPress && (
                    <Pressable
                        onPress={onPresetPress}
                        hitSlop={10}
                        style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center', marginRight: 2 }}
                    >
                        {presetEmoji ? (
                            <Text style={{ fontSize: 20 }}>{presetEmoji}</Text>
                        ) : (
                            <Ionicons name="sparkles-outline" size={20} color={theme.colors.header.tint} style={{ opacity: 0.5 }} />
                        )}
                    </Pressable>
                )}
                {avatarId && onAvatarPress && (
                    <Pressable
                        onPress={onAvatarPress}
                        hitSlop={15}
                        style={styles.avatarButton}
                    >
                        <Avatar
                            id={avatarId}
                            size={32}
                            monochrome={!isConnected}
                            flavor={flavor}
                        />
                    </Pressable>
                )}
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
    },
    backButton: {
        marginRight: 8,
    },
    titleContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'flex-start',
    },
    title: {
        fontSize: Platform.select({
            ios: 15,
            android: 15,
            default: 16
        }),
        fontWeight: '600',
        marginBottom: 1,
        width: '100%',
    },
    subtitle: {
        fontSize: 12,
        fontWeight: '400',
        lineHeight: 14,
    },
    avatarButton: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: Platform.select({ ios: -8, default: -8 }),
    },
});