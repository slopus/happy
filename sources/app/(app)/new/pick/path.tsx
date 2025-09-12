import React, { useState, useMemo, useRef } from 'react';
import { View, Text, ScrollView, Pressable } from 'react-native';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { Typography } from '@/constants/Typography';
import { useAllMachines, useSessions } from '@/sync/storage';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { formatPathRelativeToHome } from '@/utils/sessionUtils';
import { MultiTextInput, MultiTextInputHandle } from '@/components/MultiTextInput';
import { callbacks } from '../index';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    scrollContainer: {
        flex: 1,
    },
    scrollContent: {
        paddingVertical: 16,
        alignItems: 'center',
    },
    contentWrapper: {
        width: '100%',
        maxWidth: layout.maxWidth,
    },
    emptyContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
    emptyText: {
        fontSize: 16,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        ...Typography.default(),
    },
    pathInputContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 16,
    },
    pathInput: {
        flex: 1,
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        paddingHorizontal: 12,
        minHeight: 36,
        position: 'relative',
        borderWidth: 0.5,
        borderColor: theme.colors.divider,
    },
    inlineSendButton: {
        position: 'absolute',
        right: 4,
        top: '50%',
        transform: [{ translateY: -16 }],
        width: 32,
        height: 32,
        borderRadius: 16,
        justifyContent: 'center',
        alignItems: 'center',
    },
    inlineSendActive: {
        backgroundColor: theme.colors.button.primary.background,
    },
    inlineSendInactive: {
        backgroundColor: 'transparent',
    },
}));

export default function PathPickerScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const params = useLocalSearchParams<{ machineId?: string; selectedPath?: string }>();
    const machines = useAllMachines();
    const sessions = useSessions();
    const inputRef = useRef<MultiTextInputHandle>(null);

    const [customPath, setCustomPath] = useState(params.selectedPath || '~');
    const [showAllPaths, setShowAllPaths] = useState(false);

    // Get the selected machine
    const machine = useMemo(() => {
        return machines.find(m => m.id === params.machineId);
    }, [machines, params.machineId]);

    // Get recent paths for this machine from sessions
    const recentPaths = useMemo(() => {
        if (!sessions || !params.machineId) return [];

        const pathSet = new Set<string>();
        const pathsWithTimestamps: Array<{ path: string; timestamp: number }> = [];

        sessions.forEach(item => {
            if (typeof item === 'string') return; // Skip section headers

            const session = item as any;
            if (session.metadata?.machineId === params.machineId && session.metadata?.path) {
                const path = session.metadata.path;
                if (!pathSet.has(path)) {
                    pathSet.add(path);
                    pathsWithTimestamps.push({
                        path,
                        timestamp: session.updatedAt || session.createdAt
                    });
                }
            }
        });

        // Sort by most recent first and return just the paths
        return pathsWithTimestamps
            .sort((a, b) => b.timestamp - a.timestamp)
            .map(item => item.path);
    }, [sessions, params.machineId]);

    const pathsToShow = showAllPaths ? recentPaths : recentPaths.slice(0, 5);

    const handleSelectPath = () => {
        const pathToUse = customPath.trim() || '~';
        // Set the selection and go back
        callbacks.onPathSelected(pathToUse);
        router.back();
    };

    if (!machine) {
        return (
            <>
                <Stack.Screen
                    options={{
                        headerShown: true,
                        headerTitle: 'Select Path',
                        headerBackTitle: t('common.back')
                    }}
                />
                <View style={styles.container}>
                    <View style={styles.emptyContainer}>
                        <Text style={styles.emptyText}>
                            No machine selected
                        </Text>
                    </View>
                </View>
            </>
        );
    }

    return (
        <>
            <View style={styles.container}>
                <ScrollView
                    style={styles.scrollContainer}
                    contentContainerStyle={styles.scrollContent}
                    keyboardShouldPersistTaps="handled"
                >
                    <View style={styles.contentWrapper}>
                        <ItemGroup title="Enter Path">
                            <View style={styles.pathInputContainer}>
                                <View style={[styles.pathInput, { paddingVertical: 8 }]}>
                                    <MultiTextInput
                                        ref={inputRef}
                                        value={customPath}
                                        onChangeText={setCustomPath}
                                        placeholder="Enter path (e.g. ~/projects)"
                                        maxHeight={76}
                                        paddingTop={8}
                                        paddingBottom={8}
                                        paddingRight={48}
                                        // onSubmitEditing={handleSelectPath}
                                        // blurOnSubmit={true}
                                        // returnKeyType="done"
                                    />
                                    <Pressable
                                        onPress={handleSelectPath}
                                        disabled={!customPath.trim()}
                                        style={[
                                            styles.inlineSendButton,
                                            customPath.trim() ? styles.inlineSendActive : styles.inlineSendInactive
                                        ]}
                                    >
                                        <Ionicons
                                            name="checkmark"
                                            size={16}
                                            color={customPath.trim() ? theme.colors.button.primary.tint : theme.colors.textSecondary}
                                        />
                                    </Pressable>
                                </View>
                            </View>
                        </ItemGroup>

                        {recentPaths.length > 0 && (
                            <ItemGroup title="Recent Paths">
                                {pathsToShow.map((path, index) => {
                                    const display = formatPathRelativeToHome(path, machine.metadata?.homeDir);
                                    const isSelected = customPath.trim() === display;
                                    const isLast = index === pathsToShow.length - 1;
                                    const hideDivider = isLast && pathsToShow.length <= 5;

                                    return (
                                        <Item
                                            key={path}
                                            title={display}
                                            leftElement={
                                                <Ionicons
                                                    name="folder-outline"
                                                    size={18}
                                                    color={theme.colors.textSecondary}
                                                />
                                            }
                                            onPress={() => {
                                                setCustomPath(display);
                                                setTimeout(() => inputRef.current?.focus(), 50);
                                            }}
                                            selected={isSelected}
                                            showChevron={false}
                                            pressableStyle={isSelected ? { backgroundColor: theme.colors.surfaceSelected } : undefined}
                                            showDivider={!hideDivider}
                                        />
                                    );
                                })}

                                {recentPaths.length > 5 && (
                                    <Item
                                        title={showAllPaths ? t('machineLauncher.showLess') : t('machineLauncher.showAll', { count: recentPaths.length })}
                                        onPress={() => setShowAllPaths(!showAllPaths)}
                                        showChevron={false}
                                        showDivider={false}
                                        titleStyle={{
                                            textAlign: 'center',
                                            color: (theme as any).dark ? theme.colors.button.primary.tint : theme.colors.button.primary.background
                                        }}
                                    />
                                )}
                            </ItemGroup>
                        )}

                        {recentPaths.length === 0 && (
                            <ItemGroup title="Suggested Paths">
                                {['~', '~/projects', '~/Documents', '~/Desktop'].map((path, index) => {
                                    const display = formatPathRelativeToHome(path, machine.metadata?.homeDir);
                                    const isSelected = customPath.trim() === display;

                                    return (
                                        <Item
                                            key={path}
                                            title={display}
                                            leftElement={
                                                <Ionicons
                                                    name="folder-outline"
                                                    size={18}
                                                    color={theme.colors.textSecondary}
                                                />
                                            }
                                            onPress={() => {
                                                setCustomPath(display);
                                                setTimeout(() => inputRef.current?.focus(), 50);
                                            }}
                                            selected={isSelected}
                                            showChevron={false}
                                            pressableStyle={isSelected ? { backgroundColor: theme.colors.surfaceSelected } : undefined}
                                        />
                                    );
                                })}
                            </ItemGroup>
                        )}
                    </View>
                </ScrollView>
            </View>
        </>
    );
}