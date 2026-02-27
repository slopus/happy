import * as React from 'react';
import { View, ActivityIndicator, Pressable, Keyboard, Platform, KeyboardAvoidingView as RNKeyboardAvoidingView } from 'react-native';
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';
import { Modal } from '@/modal';
import { hapticsLight } from '@/components/haptics';
import { showToast } from '@/components/Toast';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';
import { CodeEditor, type CodeEditorHandle } from '@/components/CodeEditor';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getTempData } from '@/utils/tempDataStore';
import { storage } from '@/sync/storage';
import { saveRegisteredRepos } from '@/sync/repoStore';
import { sync } from '@/sync/sync';
import type { RegisteredRepo } from '@/utils/workspaceRepos';

interface ScriptEditorData {
    machineId: string;
    repoId: string;
    field: keyof RegisteredRepo;
    title: string;
    value: string;
}

/**
 * Full-page script editor using Monaco with shell highlighting.
 * Receives script data via tempDataStore (dataId URL param).
 * Saves changes back to Zustand store + server KV via saveRegisteredRepos.
 */
export default React.memo(function ScriptEditorScreen() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const editorRef = React.useRef<CodeEditorHandle>(null);
    const { dataId } = useLocalSearchParams<{ dataId: string }>();

    // Load initial data from tempDataStore
    const initialData = React.useRef<ScriptEditorData | null>(null);
    if (!initialData.current && dataId) {
        initialData.current = getTempData<ScriptEditorData>(dataId);
    }

    const data = initialData.current;
    const [content, setContent] = React.useState(data?.value ?? '');
    const originalContentRef = React.useRef(data?.value ?? '');
    const [isSaving, setIsSaving] = React.useState(false);
    const [keyboardHeight, setKeyboardHeight] = React.useState(0);

    const hasChanges = content !== originalContentRef.current;
    const lineCount = React.useMemo(() => Math.max(1, content.split('\n').length), [content]);
    const editorBottomPadding = React.useMemo(() => {
        if (Platform.OS === 'web') {
            return 16;
        }
        if (keyboardHeight > 0) {
            return insets.bottom + 88;
        }
        return insets.bottom + 16;
    }, [insets.bottom, keyboardHeight]);

    // Blur editor on initial focus to prevent auto-keyboard
    useFocusEffect(
        React.useCallback(() => {
            const frame = requestAnimationFrame(() => {
                editorRef.current?.blur();
                Keyboard.dismiss();
            });
            return () => cancelAnimationFrame(frame);
        }, []),
    );

    // Track keyboard height on native platforms
    React.useEffect(() => {
        if (Platform.OS === 'web') return;
        const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
        const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

        const showSub = Keyboard.addListener(showEvent, (event) => {
            setKeyboardHeight(event.endCoordinates?.height ?? 0);
        });
        const hideSub = Keyboard.addListener(hideEvent, () => {
            setKeyboardHeight(0);
            if (Platform.OS === 'ios') {
                requestAnimationFrame(() => {
                    editorRef.current?.blur();
                });
            }
        });

        return () => {
            showSub.remove();
            hideSub.remove();
        };
    }, []);

    // Save script to Zustand store + server KV
    const handleSave = React.useCallback(async () => {
        if (!hasChanges || isSaving || !data) return;
        setIsSaving(true);
        try {
            const credentials = sync.getCredentials();
            if (!credentials) return;

            const state = storage.getState();
            const currentRepos = state.registeredRepos[data.machineId] || [];
            const version = state.registeredReposVersions[data.machineId] ?? -1;

            const updatedRepos = currentRepos.map(r =>
                r.id === data.repoId ? { ...r, [data.field]: content || undefined } : r
            );

            const newVersion = await saveRegisteredRepos(credentials, data.machineId, updatedRepos, version);
            storage.getState().setRegisteredRepos(data.machineId, updatedRepos, newVersion);

            originalContentRef.current = content;
            hapticsLight();
            showToast(t('files.saved'));
        } catch {
            Modal.alert(t('common.error'), t('files.saveFailed'));
        } finally {
            setIsSaving(false);
        }
    }, [content, hasChanges, isSaving, data]);

    // Confirm discard on back navigation
    const handleBack = React.useCallback(async () => {
        if (hasChanges) {
            const confirmed = await Modal.confirm(
                t('common.discard'),
                t('artifacts.discardChangesDescription'),
            );
            if (!confirmed) return;
        }
        router.back();
    }, [hasChanges, router]);

    // If temp data was not found, show nothing (edge case: expired data)
    if (!data) {
        return (
            <View style={[styles.container, { backgroundColor: theme.colors.surface, justifyContent: 'center', alignItems: 'center' }]}>
                <Stack.Screen options={{ headerTitle: '' }} />
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }

    const infoBar = (
        <View style={{
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: 8,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.divider,
            backgroundColor: theme.colors.surfaceHigh,
        }}>
            <Text style={{
                ...Typography.mono(),
                fontSize: 12,
                color: theme.colors.textSecondary,
            }}>
                Shell  {'\u2022'}  {lineCount}
            </Text>
        </View>
    );

    const editor = (
        <View style={{ flex: 1 }}>
            <CodeEditor
                ref={editorRef}
                value={content}
                onChangeText={setContent}
                bottomPadding={editorBottomPadding}
                language="shell"
            />
        </View>
    );

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.surface }]}>
            <Stack.Screen
                options={{
                    headerTitle: data.title,
                    headerLeft: () => (
                        <Pressable onPress={handleBack} style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
                            <Ionicons name="chevron-back" size={24} color={theme.colors.header.tint} />
                        </Pressable>
                    ),
                    headerRight: () => (
                        <Pressable
                            onPress={handleSave}
                            disabled={!hasChanges || isSaving}
                            style={{ paddingHorizontal: 8, paddingVertical: 4 }}
                        >
                            {isSaving ? (
                                <ActivityIndicator size="small" color={theme.colors.header.tint} />
                            ) : (
                                <Text style={{
                                    fontSize: 17,
                                    color: hasChanges ? theme.colors.header.tint : theme.colors.textSecondary,
                                    ...Typography.default('semiBold'),
                                }}>
                                    {t('common.save')}
                                </Text>
                            )}
                        </Pressable>
                    ),
                    headerBackVisible: false,
                    headerTitleAlign: 'center',
                }}
            />
            {Platform.OS === 'ios' ? (
                <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={0} style={{ flex: 1 }}>
                    {infoBar}
                    {editor}
                </KeyboardAvoidingView>
            ) : Platform.OS === 'android' ? (
                <RNKeyboardAvoidingView behavior="padding" keyboardVerticalOffset={0} style={{ flex: 1 }}>
                    {infoBar}
                    {editor}
                </RNKeyboardAvoidingView>
            ) : (
                <>
                    {infoBar}
                    {editor}
                </>
            )}
        </View>
    );
});

const styles = StyleSheet.create((_theme) => ({
    container: {
        flex: 1,
        width: '100%',
    },
}));
