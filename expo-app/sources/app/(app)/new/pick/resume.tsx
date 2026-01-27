import React from 'react';
import { View, Text, Pressable, InteractionManager } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { CommonActions, useFocusEffect, useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { MultiTextInput, type MultiTextInputHandle } from '@/components/MultiTextInput';
import type { AgentId } from '@/agents/catalog';
import { DEFAULT_AGENT_ID, getAgentCore, isAgentId } from '@/agents/catalog';
import { getClipboardStringTrimmedSafe } from '@/utils/ui/clipboard';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    inputSection: {
        padding: 16,
        alignSelf: 'center',
        width: '100%',
        maxWidth: layout.maxWidth,
    },
    inputLabel: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        marginBottom: 8,
        ...Typography.default('semiBold'),
    },
    inputContainer: {
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderWidth: 0.5,
        borderColor: theme.colors.divider,
    },
    buttonRow: {
        flexDirection: 'row',
        gap: 12,
        marginTop: 16,
    },
    button: {
        flex: 1,
        paddingVertical: 12,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttonPrimary: {
        backgroundColor: theme.colors.button.primary.background,
    },
    buttonSecondary: {
        backgroundColor: theme.colors.surface,
        borderWidth: 0.5,
        borderColor: theme.colors.divider,
    },
    buttonText: {
        fontSize: 15,
        ...Typography.default('semiBold'),
    },
    buttonTextPrimary: {
        color: theme.colors.button.primary.tint,
    },
    buttonTextSecondary: {
        color: theme.colors.text,
    },
    clearButton: {
        marginTop: 12,
        paddingVertical: 12,
        alignItems: 'center',
    },
    clearButtonText: {
        fontSize: 15,
        color: theme.colors.textDestructive,
        ...Typography.default('semiBold'),
    },
    helpText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginTop: 12,
        lineHeight: 20,
        ...Typography.default(),
    },
}));

export default function ResumePickerScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const navigation = useNavigation();
    const inputRef = React.useRef<MultiTextInputHandle>(null);
    const params = useLocalSearchParams<{
        currentResumeId?: string;
        agentType?: AgentId;
    }>();

    const [inputValue, setInputValue] = React.useState(params.currentResumeId || '');
    const agentType: AgentId = isAgentId(params.agentType) ? params.agentType : DEFAULT_AGENT_ID;
    const agentLabel = t(getAgentCore(agentType).displayNameKey);

    const handleSave = () => {
        const trimmed = inputValue.trim();
        const state = navigation.getState();
        if (!state) {
            router.back();
            return;
        }
        const previousRoute = state.routes[state.index - 1];
        if (previousRoute) {
            navigation.dispatch({
                ...CommonActions.setParams({ resumeSessionId: trimmed }),
                source: previousRoute.key,
            } as never);
        }
        router.back();
    };

    const handleClear = () => {
        const state = navigation.getState();
        if (!state) {
            router.back();
            return;
        }
        const previousRoute = state.routes[state.index - 1];
        if (previousRoute) {
            navigation.dispatch({
                ...CommonActions.setParams({ resumeSessionId: '' }),
                source: previousRoute.key,
            } as never);
        }
        router.back();
    };

    const handlePaste = async () => {
        const text = await getClipboardStringTrimmedSafe();
        if (text) {
            setInputValue(text);
        }
    };

    const focusInputWithRetries = React.useCallback(() => {
        let cancelled = false;
        const focus = () => {
            if (cancelled) return;
            inputRef.current?.focus();
        };

        // Try immediately (best chance to succeed on web because it happens soon after navigation).
        focus();

        // Also retry across a few frames to catch cases where the input isn't mounted yet.
        let rafAttempts = 0;
        const raf =
            typeof (globalThis as any).requestAnimationFrame === 'function'
                ? ((globalThis as any).requestAnimationFrame as (cb: (ts: number) => void) => any).bind(globalThis)
                : (cb: (ts: number) => void) => setTimeout(() => cb(Date.now()), 16);
        const caf =
            typeof (globalThis as any).cancelAnimationFrame === 'function'
                ? ((globalThis as any).cancelAnimationFrame as (id: any) => void).bind(globalThis)
                : (id: any) => clearTimeout(id);
        let rafId: any = null;
        const rafLoop = () => {
            rafAttempts += 1;
            focus();
            if (rafAttempts < 8) {
                rafId = raf(rafLoop);
            }
        };
        rafId = raf(rafLoop);

        // And a time-based fallback for native modal transitions / slower mounts.
        const timer = setTimeout(focus, 300);

        return () => {
            cancelled = true;
            clearTimeout(timer);
            if (rafId !== null) caf(rafId);
        };
    }, []);

    React.useEffect(() => {
        const cleanup = focusInputWithRetries();
        return cleanup;
    }, [focusInputWithRetries]);

    // Auto-focus the input when the screen becomes active. Relying on `autoFocus` alone can fail
    // with native modal transitions / nested navigators.
    useFocusEffect(React.useCallback(() => {
        const cleanup = focusInputWithRetries();

        // Prefer `InteractionManager` to wait for modal/navigation animations to settle.
        let interactionCleanup: (() => void) | undefined;
        const task = InteractionManager.runAfterInteractions(() => {
            interactionCleanup = focusInputWithRetries();
        });

        return () => {
            task.cancel?.();
            interactionCleanup?.();
            cleanup();
        };
    }, [focusInputWithRetries]));

    const headerTitle = t('newSession.resume.pickerTitle');
    const headerBackTitle = t('common.cancel');
    const screenOptions = React.useMemo(() => {
        return {
            headerShown: true,
            title: headerTitle,
            headerTitle,
            headerBackTitle,
        } as const;
    }, [headerBackTitle, headerTitle]);

    return (
        <>
            <Stack.Screen
                options={screenOptions}
            />
            <View style={styles.container}>
                <ItemList>
                    <ItemGroup>
                        <View style={styles.inputSection}>
                            <Text style={styles.inputLabel}>
                                {t('newSession.resume.subtitle', { agent: agentLabel })}
                            </Text>

                            <View style={styles.inputContainer}>
                                <MultiTextInput
                                    ref={inputRef}
                                    value={inputValue}
                                    onChangeText={setInputValue}
                                    placeholder={
                                        t('newSession.resume.placeholder', { agent: agentLabel })
                                    }
                                    autoFocus={true}
                                    maxHeight={80}
                                    paddingTop={0}
                                    paddingBottom={0}
                                />
                            </View>

                            <View style={styles.buttonRow}>
                                <Pressable
                                    onPress={handlePaste}
                                    style={({ pressed }) => [
                                        styles.button,
                                        styles.buttonSecondary,
                                        { opacity: pressed ? 0.7 : 1 },
                                    ]}
                                >
                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                        <Ionicons name="clipboard-outline" size={18} color={theme.colors.text} />
                                        <Text style={[styles.buttonText, styles.buttonTextSecondary]}>
                                            {t('newSession.resume.paste')}
                                        </Text>
                                    </View>
                                </Pressable>
                                <Pressable
                                    onPress={handleSave}
                                    style={({ pressed }) => [
                                        styles.button,
                                        styles.buttonPrimary,
                                        { opacity: pressed ? 0.7 : 1 },
                                    ]}
                                >
                                    <Text style={[styles.buttonText, styles.buttonTextPrimary]}>
                                        {t('newSession.resume.save')}
                                    </Text>
                                </Pressable>
                            </View>

                            {inputValue.trim() && (
                                <Pressable
                                    onPress={handleClear}
                                    style={({ pressed }) => [
                                        styles.clearButton,
                                        { opacity: pressed ? 0.7 : 1 },
                                    ]}
                                >
                                    <Text style={styles.clearButtonText}>
                                        {t('newSession.resume.clearAndRemove')}
                                    </Text>
                                </Pressable>
                            )}

                            <Text style={styles.helpText}>
                                {t('newSession.resume.helpText')}
                            </Text>
                        </View>
                    </ItemGroup>
                </ItemList>
            </View>
        </>
    );
}
