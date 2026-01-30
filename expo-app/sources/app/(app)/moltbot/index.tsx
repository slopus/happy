import * as React from 'react';
import { View, Text, Platform, Pressable } from 'react-native';
import { MoltbotView } from '@/components/MoltbotView';
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
    header: {
        backgroundColor: theme.colors.header.background,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    headerContent: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
    },
    headerLeft: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    backButton: {
        marginRight: 16,
    },
    headerTitle: {
        fontSize: 17,
        color: theme.colors.header.tint,
        ...Typography.default('semiBold'),
    },
    addButton: {
        padding: 4,
    },
}));

export default React.memo(function MoltbotPage() {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const isTablet = useIsTablet();
    const router = useRouter();
    const headerHeight = useHeaderHeight();

    // In phone mode, show header with back button and add button
    if (!isTablet) {
        return (
            <View style={styles.container}>
                <View style={[styles.header, { paddingTop: insets.top }]}>
                    <View style={[styles.headerContent, { height: headerHeight }]}>
                        <View style={styles.headerLeft}>
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
                            <Text style={styles.headerTitle}>{t('tabs.moltbot')}</Text>
                        </View>
                        <Pressable
                            onPress={() => router.push('/moltbot/add')}
                            style={styles.addButton}
                            hitSlop={15}
                        >
                            <Ionicons
                                name="add-outline"
                                size={28}
                                color={theme.colors.header.tint}
                            />
                        </Pressable>
                    </View>
                </View>
                <MoltbotView />
            </View>
        );
    }

    // Tablet mode: MoltbotView handles its own header
    return <MoltbotView />;
});
