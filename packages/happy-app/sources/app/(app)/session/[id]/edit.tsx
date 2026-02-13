import * as React from 'react';
import { View, ActivityIndicator, Pressable, Keyboard, Platform, KeyboardAvoidingView as RNKeyboardAvoidingView } from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import * as Crypto from 'expo-crypto';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';
import { encodeHex } from '@/encryption/hex';
import { sessionReadFile, sessionWriteFile } from '@/sync/ops';
import { Modal } from '@/modal';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';
import { CodeEditor, type CodeEditorHandle } from '@/components/CodeEditor';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

function getFileLanguage(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase();
    switch (ext) {
        case 'js':
        case 'jsx':
            return 'JavaScript';
        case 'ts':
        case 'tsx':
            return 'TypeScript';
        case 'py':
            return 'Python';
        case 'html':
        case 'htm':
            return 'HTML';
        case 'css':
            return 'CSS';
        case 'json':
            return 'JSON';
        case 'md':
            return 'Markdown';
        case 'xml':
            return 'XML';
        case 'yaml':
        case 'yml':
            return 'YAML';
        case 'sh':
        case 'bash':
            return 'Shell';
        case 'sql':
            return 'SQL';
        case 'go':
            return 'Go';
        case 'rs':
        case 'rust':
            return 'Rust';
        case 'java':
            return 'Java';
        case 'c':
            return 'C';
        case 'cpp':
        case 'cc':
        case 'cxx':
            return 'C++';
        case 'php':
            return 'PHP';
        case 'rb':
            return 'Ruby';
        case 'swift':
            return 'Swift';
        case 'kt':
            return 'Kotlin';
        default:
            return 'Plain Text';
    }
}

function getEditorLanguage(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase();
    switch (ext) {
        case 'js':
        case 'jsx':
            return 'javascript';
        case 'ts':
        case 'tsx':
            return 'typescript';
        case 'py':
            return 'python';
        case 'html':
        case 'htm':
            return 'html';
        case 'css':
            return 'css';
        case 'json':
            return 'json';
        case 'md':
            return 'markdown';
        case 'xml':
            return 'xml';
        case 'yaml':
        case 'yml':
            return 'yaml';
        case 'sh':
        case 'bash':
            return 'shell';
        case 'sql':
            return 'sql';
        case 'go':
            return 'go';
        case 'rs':
        case 'rust':
            return 'rust';
        case 'java':
            return 'java';
        case 'c':
            return 'c';
        case 'cpp':
        case 'cc':
        case 'cxx':
            return 'cpp';
        case 'php':
            return 'php';
        case 'rb':
            return 'ruby';
        case 'swift':
            return 'swift';
        case 'kt':
            return 'kotlin';
        default:
            return 'plaintext';
    }
}

export default function EditScreen() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const { id: sessionId } = useLocalSearchParams<{ id: string }>();
    const editorRef = React.useRef<CodeEditorHandle>(null);
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
    const language = React.useMemo(() => getFileLanguage(filePath), [filePath]);
    const editorLanguage = React.useMemo(() => getEditorLanguage(filePath), [filePath]);

    const [content, setContent] = React.useState('');
    const [originalContent, setOriginalContent] = React.useState('');
    const [originalHash, setOriginalHash] = React.useState<string | null>(null);
    const [isLoading, setIsLoading] = React.useState(true);
    const [isSaving, setIsSaving] = React.useState(false);
    const [keyboardHeight, setKeyboardHeight] = React.useState(0);
    const [error, setError] = React.useState<string | null>(null);

    const hasChanges = content !== originalContent;
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

    // Load file content
    React.useEffect(() => {
        let cancelled = false;

        const load = async () => {
            setIsLoading(true);
            setError(null);
            setOriginalHash(null);
            try {
                const response = await sessionReadFile(sessionId!, filePath);
                if (cancelled) return;

                if (response.success && typeof response.content === 'string') {
                    const binaryString = atob(response.content);
                    const bytes = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                    }
                    const hashBuffer = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
                    const currentHash = encodeHex(new Uint8Array(hashBuffer)).toLowerCase();
                    const decoded = new TextDecoder('utf-8').decode(bytes);
                    setContent(decoded);
                    setOriginalContent(decoded);
                    setOriginalHash(currentHash);
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

    // Some devices auto-focus the first TextInput on navigation.
    // Explicitly blur on focus so keyboard only shows after user taps editor.
    useFocusEffect(
        React.useCallback(() => {
            const frame = requestAnimationFrame(() => {
                editorRef.current?.blur();
                Keyboard.dismiss();
            });
            return () => cancelAnimationFrame(frame);
        }, []),
    );

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

    // Save file
    const handleSave = React.useCallback(async () => {
        if (!hasChanges || isSaving) return;
        if (!originalHash) {
            Modal.alert(t('common.error'), 'Failed to save file: missing file version hash');
            return;
        }
        setIsSaving(true);
        try {
            // Encode content to base64 (UTF-8 safe)
            const bytes = new TextEncoder().encode(content);
            const base64 = btoa(bytes.reduce((s, b) => s + String.fromCharCode(b), ''));

            const response = await sessionWriteFile(sessionId!, filePath, base64, originalHash.toLowerCase());
            if (response.success) {
                setOriginalContent(content);
                if (response.hash) {
                    setOriginalHash(response.hash.toLowerCase());
                } else {
                    const savedHashBuffer = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
                    setOriginalHash(encodeHex(new Uint8Array(savedHashBuffer)).toLowerCase());
                }
                Modal.alert(t('common.success'), t('files.saved'));
            } else {
                Modal.alert(t('common.error'), response.error || t('files.saveFailed'));
            }
        } catch {
            Modal.alert(t('common.error'), t('files.saveFailed'));
        } finally {
            setIsSaving(false);
        }
    }, [content, hasChanges, isSaving, originalHash, sessionId, filePath]);

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
            {Platform.OS === 'ios' ? (
                <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={0} style={{ flex: 1 }}>
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
                            {language}  •  {lineCount}
                        </Text>
                    </View>
                    <View style={{ flex: 1 }}>
                        <CodeEditor
                            ref={editorRef}
                            value={content}
                            onChangeText={setContent}
                            bottomPadding={editorBottomPadding}
                            language={editorLanguage}
                        />
                    </View>
                </KeyboardAvoidingView>
            ) : Platform.OS === 'android' ? (
                <RNKeyboardAvoidingView behavior="padding" keyboardVerticalOffset={0} style={{ flex: 1 }}>
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
                            {language}  •  {lineCount}
                        </Text>
                    </View>
                    <View style={{ flex: 1 }}>
                        <CodeEditor
                            ref={editorRef}
                            value={content}
                            onChangeText={setContent}
                            bottomPadding={editorBottomPadding}
                            language={editorLanguage}
                        />
                    </View>
                </RNKeyboardAvoidingView>
            ) : (
                <>
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
                            {language}  •  {lineCount}
                        </Text>
                    </View>
                    <View style={{ flex: 1 }}>
                        <CodeEditor
                            ref={editorRef}
                            value={content}
                            onChangeText={setContent}
                            bottomPadding={editorBottomPadding}
                            language={editorLanguage}
                        />
                    </View>
                </>
            )}
        </View>
    );
}

const styles = StyleSheet.create((_theme) => ({
    container: {
        flex: 1,
        width: '100%',
    },
}));
