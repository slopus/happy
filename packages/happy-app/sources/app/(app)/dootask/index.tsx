import * as React from 'react';
import { View, Text, Platform, Pressable } from 'react-native';
import { BottomSheetModal } from '@gorhom/bottom-sheet';
import { DooTaskListView } from '@/components/DooTaskListView';
import { DooTaskCreateSheet } from '@/components/dootask/DooTaskCreateSheet';
import { DooTaskCreateTaskSheet } from '@/components/dootask/DooTaskCreateTaskSheet';
import { DooTaskCreateProjectSheet } from '@/components/dootask/DooTaskCreateProjectSheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useIsTablet, useHeaderHeight } from '@/utils/responsive';
import { useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

const styles = StyleSheet.create((theme) => ({
    outerContainer: {
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

export default function DooTaskPage() {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const isTablet = useIsTablet();
    const router = useRouter();
    const headerHeight = useHeaderHeight();

    const [createMenuVisible, setCreateMenuVisible] = React.useState(false);
    const createTaskSheetRef = React.useRef<BottomSheetModal>(null);
    const createProjectSheetRef = React.useRef<BottomSheetModal>(null);

    const handleCreatePress = React.useCallback(() => {
        setCreateMenuVisible(true);
    }, []);

    const handleCreateMenuClose = React.useCallback(() => {
        setCreateMenuVisible(false);
    }, []);

    const handleSelectTask = React.useCallback(() => {
        createTaskSheetRef.current?.present();
    }, []);

    const handleSelectProject = React.useCallback(() => {
        createProjectSheetRef.current?.present();
    }, []);

    const createSheets = (
        <>
            <DooTaskCreateSheet
                visible={createMenuVisible}
                onClose={handleCreateMenuClose}
                onSelectTask={handleSelectTask}
                onSelectProject={handleSelectProject}
            />
            <DooTaskCreateTaskSheet ref={createTaskSheetRef} />
            <DooTaskCreateProjectSheet ref={createProjectSheetRef} />
        </>
    );

    if (!isTablet) {
        return (
            <View style={styles.outerContainer}>
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
                        <Text style={styles.headerTitle}>{t('tabs.dootask')}</Text>
                        <View style={{ flex: 1 }} />
                        <Pressable
                            onPress={handleCreatePress}
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
                <DooTaskListView />
                {createSheets}
            </View>
        );
    }

    return (
        <View style={styles.outerContainer}>
            <Stack.Screen
                options={{
                    title: t('tabs.dootask'),
                    headerRight: () => (
                        <Pressable
                            onPress={handleCreatePress}
                            hitSlop={15}
                        >
                            <Ionicons
                                name="add-outline"
                                size={24}
                                color={theme.colors.header.tint}
                            />
                        </Pressable>
                    ),
                }}
            />
            <DooTaskListView />
            {createSheets}
        </View>
    );
}
