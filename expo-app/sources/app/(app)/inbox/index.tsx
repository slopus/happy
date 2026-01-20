import * as React from 'react';
import { View, Text, Platform, Pressable } from 'react-native';
import { InboxView } from "@/components/InboxView";
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useIsTablet, useHeaderHeight } from '@/utils/responsive';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
    },
    gradientOverlay: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 1,
        pointerEvents: 'none',
    },
    tabletHeader: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 10,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
    },
    tabletTitle: {
        fontSize: 34,
        fontWeight: '700',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    addFriendButton: {
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: theme.colors.surface,
        alignItems: 'center',
        justifyContent: 'center',
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 4,
        elevation: 4,
    },
    header: {
        backgroundColor: theme.colors.header.background,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    headerContent: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
    },
    backButton: {
        marginRight: 16,
    },
    headerTitle: {
        fontSize: 17,
        color: theme.colors.header.tint,
        ...Typography.default('semiBold'),
    },
}));

export default function InboxPage() {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const isTablet = useIsTablet();
    const router = useRouter();
    const headerHeight = useHeaderHeight();

    // Calculate gradient height: safe area + some extra for the fade effect
    const gradientHeight = insets.top + 40;

    // Create gradient colors from opaque background to transparent
    const gradientColors: readonly [string, string, ...string[]] = [
        theme.colors.groupped.background,
        theme.colors.groupped.background + 'E6', // 90% opacity
        theme.colors.groupped.background + '99', // 60% opacity
        theme.colors.groupped.background + '33', // 20% opacity
        theme.colors.groupped.background + '00', // transparent
    ] as const;

    // In phone mode, show header; in tablet mode, show gradient
    if (!isTablet) {
        // Phone mode: render with header
        return (
            <View style={styles.container}>
                <View style={[styles.header, { paddingTop: insets.top }]}>
                    <View style={[styles.headerContent, { height: headerHeight }]}>
                        <Pressable
                            onPress={() => router.back()}
                            style={styles.backButton}
                            hitSlop={15}
                        >
                            <Ionicons
                                name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'}
                                size={24}
                                color={theme.colors.header.tint}
                            />
                        </Pressable>
                        <Text style={styles.headerTitle}>{t('tabs.inbox')}</Text>
                    </View>
                </View>
                <InboxView />
            </View>
        );
    }

    // Tablet mode: render with header and friend button
    return (
        <InboxView />
    );
}