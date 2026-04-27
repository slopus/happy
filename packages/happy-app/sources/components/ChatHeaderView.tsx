import * as React from 'react';
import { View, Text, StyleSheet, Platform, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';
import { useHeaderHeight } from '@/utils/responsive';
import { layout } from '@/components/layout';
import { useUnistyles } from 'react-native-unistyles';

interface ChatHeaderViewProps {
    title: string;
    subtitle?: string;
    onTitlePress?: () => void;
    backgroundColor?: string;
    tintColor?: string;
    isConnected?: boolean;
}

export const ChatHeaderView: React.FC<ChatHeaderViewProps> = ({
    title,
    subtitle,
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
});
