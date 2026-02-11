import * as React from 'react';
import { View, TextInput, ActivityIndicator, Pressable } from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';
import { sessionReadFile, sessionWriteFile } from '@/sync/ops';
import { Modal } from '@/modal';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { t } from '@/text';

export default function EditScreen() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const { id: sessionId } = useLocalSearchParams<{ id: string }>();
    const searchParams = useLocalSearchParams();
    const encodedPath = searchParams.path as string;
    let filePath = '';

    try {
        if (encodedPath) {
            const binaryString = atob(encodedPath);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            filePath = new TextDecoder('utf-8').decode(bytes);
        }
    } catch {
        filePath = encodedPath || '';
    }

    const fileName = filePath.split('/').pop() || filePath;

    const [content, setContent] = React.useState('');
    const [originalContent, setOriginalContent] = React.useState('');
    const [isLoading, setIsLoading] = React.useState(true);
    const [isSaving, setIsSaving] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const hasChanges = content !== originalContent;

    // Load file content
    React.useEffect(() => {
        let cancelled = false;

        const load = async () => {
            setIsLoading(true);
            setError(null);
            try {
                const response = await sessionReadFile(sessionId!, filePath);
                if (cancelled) return;

                if (response.success && response.content) {
                    const binaryString = atob(response.content);
                    const bytes = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                    }
                    const decoded = new TextDecoder('utf-8').decode(bytes);
                    setContent(decoded);
                    setOriginalContent(decoded);
                } else {
                    setError(response.error || 'Failed to read file');
                }
            } catch {
                if (!cancelled) setError('Failed to read file');
            } finally {
                if (!cancelled) setIsLoading(false);
            }
        };

        load();
        return () => { cancelled = true; };
    }, [sessionId, filePath]);

    // Save file
    const handleSave = React.useCallback(async () => {
        if (!hasChanges || isSaving) return;
        setIsSaving(true);
        try {
            // Encode content to base64 (UTF-8 safe)
            const bytes = new TextEncoder().encode(content);
            const base64 = btoa(bytes.reduce((s, b) => s + String.fromCharCode(b), ''));

            const response = await sessionWriteFile(sessionId!, filePath, base64);
            if (response.success) {
                setOriginalContent(content);
                Modal.alert(t('common.success'), t('files.saved'));
            } else {
                Modal.alert(t('common.error'), response.error || t('files.saveFailed'));
            }
        } catch {
            Modal.alert(t('common.error'), t('files.saveFailed'));
        } finally {
            setIsSaving(false);
        }
    }, [content, hasChanges, isSaving, sessionId, filePath]);

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

    if (isLoading) {
        return (
            <View style={[styles.container, { backgroundColor: theme.colors.surface, justifyContent: 'center', alignItems: 'center' }]}>
                <Stack.Screen options={{ headerTitle: fileName }} />
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }

    if (error) {
        return (
            <View style={[styles.container, { backgroundColor: theme.colors.surface, justifyContent: 'center', alignItems: 'center', padding: 20 }]}>
                <Stack.Screen options={{ headerTitle: fileName }} />
                <Ionicons name="alert-circle-outline" size={48} color={theme.colors.textSecondary} />
                <Text style={{ fontSize: 16, color: theme.colors.textSecondary, textAlign: 'center', marginTop: 16, ...Typography.default() }}>
                    {error}
                </Text>
            </View>
        );
    }

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.surface }]}>
            <Stack.Screen
                options={{
                    headerTitle: fileName,
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
                }}
            />
            <TextInput
                style={{
                    flex: 1,
                    padding: 16,
                    fontSize: 14,
                    lineHeight: 20,
                    color: theme.colors.text,
                    textAlignVertical: 'top',
                    ...Typography.mono(),
                }}
                value={content}
                onChangeText={setContent}
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                spellCheck={false}
                scrollEnabled
            />
        </View>
    );
}

const styles = StyleSheet.create((_theme) => ({
    container: {
        flex: 1,
        maxWidth: layout.maxWidth,
        alignSelf: 'center' as const,
        width: '100%',
    },
}));
