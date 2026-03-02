import * as React from 'react';
import { View, Text, StyleSheet, Platform, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { SvgXml } from 'react-native-svg';
import { useNavigation } from '@react-navigation/native';
import { Avatar } from '@/components/Avatar';
import { Typography } from '@/constants/Typography';
import { useHeaderHeight, useIsTablet } from '@/utils/responsive';
import { layout } from '@/components/layout';
import { useUnistyles } from 'react-native-unistyles';
import { useSidebarCollapse } from '@/components/SidebarNavigator';

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
    onSharePress?: () => void;
    onFileBrowserPress?: () => void;
    onSettingsPress?: () => void;
}

const chatBubbleStarSvg = (color: string) => `
<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M4 4.5C4 3.12 5.12 2 6.5 2H17.5C18.88 2 20 3.12 20 4.5V14.5C20 15.88 18.88 17 17.5 17H8L4.5 20.5C4.22 20.78 3.78 20.78 3.5 20.5C3.36 20.36 3.28 20.18 3.28 20V17.24C3.28 17.24 4 16.5 4 14.5V4.5Z" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/>
  <path d="M12 5.5L13.1 8.9L12 12.5L10.9 8.9L12 5.5Z" fill="${color}"/>
  <path d="M8.5 9L11.5 9.5L15.5 9L11.5 8.5L8.5 9Z" fill="${color}"/>
</svg>`;

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
    onSharePress,
    onFileBrowserPress,
    onSettingsPress,
}) => {
    const { theme } = useUnistyles();
    const navigation = useNavigation();
    const insets = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const isTablet = useIsTablet();
    const { collapsed: sidebarCollapsed, toggle: toggleSidebar } = useSidebarCollapse();

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
                <View style={[styles.content, { height: headerHeight }]}>
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

                {Platform.OS === 'web' && isTablet && (
                    <Pressable
                        onPress={toggleSidebar}
                        hitSlop={10}
                        style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}
                    >
                        <Ionicons name={sidebarCollapsed ? "contract-outline" : "expand-outline"} size={18} color={theme.colors.header.tint} style={{ opacity: 0.6 }} />
                    </Pressable>
                )}
                {onSettingsPress && (
                    <Pressable
                        onPress={onSettingsPress}
                        hitSlop={10}
                        style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}
                    >
                        <Ionicons name="settings-outline" size={20} color={theme.colors.header.tint} style={{ opacity: 0.6 }} />
                    </Pressable>
                )}
                {onFileBrowserPress && (
                    <Pressable
                        onPress={onFileBrowserPress}
                        hitSlop={10}
                        style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}
                    >
                        <Ionicons name="folder-outline" size={20} color={theme.colors.header.tint} style={{ opacity: 0.6 }} />
                    </Pressable>
                )}
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
        maxWidth: layout.headerMaxWidth,
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