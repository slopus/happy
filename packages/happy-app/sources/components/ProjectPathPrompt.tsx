import * as React from 'react';
import { Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { MobileGlassSurface } from './MobileGlass';
import { Typography } from '@/constants/Typography';
import { useDirSuggestions } from '@/hooks/useDirSuggestions';
import { useSetting } from '@/sync/storage';
import { t } from '@/text';

/**
 * Asks for a project directory, with the same live directory suggestions the
 * /new screen's path picker offers.
 *
 * Presented through `Modal.show`, so it settles a promise rather than returning
 * a value: `onSubmit` receives the typed path, or null if the user cancelled or
 * dismissed it.
 */
export function ProjectPathPrompt({
    defaultValue,
    machineId,
    homeDir,
    onSubmit,
    onClose,
}: {
    defaultValue: string;
    machineId?: string | null;
    homeDir?: string;
    onSubmit: (path: string | null) => void;
    /** Injected by the modal host. */
    onClose?: () => void;
}) {
    const { theme } = useUnistyles();
    const [value, setValue] = React.useState(defaultValue);
    const [selection, setSelection] = React.useState<{ start: number; end: number } | undefined>(undefined);
    const inputRef = React.useRef<TextInput>(null);
    const settledRef = React.useRef(false);

    // Autocomplete is experimental. Passing a null machineId when it is off
    // disables the hook outright — no bash calls, no list — so the prompt falls
    // back to a plain path field.
    const expDirAutocomplete = useSetting('expDirAutocomplete');
    const suggestions = useDirSuggestions(expDirAutocomplete ? machineId : null, value, homeDir);

    React.useEffect(() => {
        // The field is the whole point of this modal, and suggestions cannot
        // appear until something is typed — so open the keyboard for the user.
        const timer = setTimeout(() => inputRef.current?.focus(), 100);
        return () => clearTimeout(timer);
    }, []);

    const submit = React.useCallback((next: string | null) => {
        settledRef.current = true;
        onSubmit(next);
        onClose?.();
    }, [onClose, onSubmit]);

    const submitRef = React.useRef(submit);
    submitRef.current = submit;

    React.useEffect(() => () => {
        // A backdrop tap unmounts us without going through either button, and
        // the caller is awaiting a promise — settle it or that await never
        // returns and the picker is stuck.
        if (!settledRef.current) {
            submitRef.current(null);
        }
    }, []);

    const applySuggestion = React.useCallback((fullPath: string) => {
        // Trailing slash so the next keystroke searches inside the directory
        // just picked, which is what makes tapping down a tree work.
        const next = `${fullPath}/`;
        setValue(next);
        setSelection({ start: next.length, end: next.length });
        setTimeout(() => inputRef.current?.focus(), 0);
    }, []);

    return (
        <MobileGlassSurface
            enabled={Platform.OS !== 'web'}
            nativeEffect
            glassEffectStyle="regular"
            intensity={88}
            tintColor={theme.colors.glass.overlayTint}
            style={styles.container}
        >
            <View style={styles.content}>
                <Text style={styles.title}>{t('machineLauncher.enterCustomPath')}</Text>
                <View style={styles.inputRow}>
                    <Ionicons name="folder-outline" size={16} color={theme.colors.textSecondary} />
                    <TextInput
                        ref={inputRef}
                        value={value}
                        onChangeText={setValue}
                        onSelectionChange={(event) => setSelection(event.nativeEvent.selection)}
                        selection={selection}
                        placeholder="~/path/to/project"
                        placeholderTextColor={theme.colors.input.placeholder}
                        style={styles.input}
                        autoCapitalize="none"
                        autoCorrect={false}
                        returnKeyType="done"
                        onSubmitEditing={() => submit(value)}
                    />
                </View>
                {suggestions.length > 0 && (
                    <ScrollView style={styles.suggestionList} keyboardShouldPersistTaps="handled">
                        {suggestions.map((suggestion) => (
                            <Pressable
                                key={suggestion.fullPath}
                                onPress={() => applySuggestion(suggestion.fullPath)}
                                style={({ pressed }) => [styles.suggestion, pressed && styles.suggestionPressed]}
                            >
                                <Ionicons name="folder-outline" size={16} color={theme.colors.textSecondary} />
                                <Text style={styles.suggestionText} numberOfLines={1}>
                                    {suggestion.fullPath}
                                </Text>
                            </Pressable>
                        ))}
                    </ScrollView>
                )}
            </View>
            <View style={styles.buttonRow}>
                <Pressable
                    style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
                    onPress={() => submit(null)}
                >
                    <Text style={styles.buttonText}>{t('common.cancel')}</Text>
                </Pressable>
                <View style={styles.buttonSeparator} />
                <Pressable
                    style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
                    onPress={() => submit(value)}
                >
                    <Text style={[styles.buttonText, styles.buttonTextConfirm]}>{t('common.ok')}</Text>
                </Pressable>
            </View>
        </MobileGlassSurface>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        width: 320,
        maxWidth: '100%',
        borderRadius: 14,
        overflow: 'hidden',
        borderWidth: Platform.OS === 'web' ? 0 : StyleSheet.hairlineWidth,
        borderColor: theme.colors.glass.border,
        backgroundColor: Platform.select({
            web: theme.colors.surface,
            ios: theme.colors.glass.overlay,
            android: theme.colors.glass.backgroundStrong,
            default: theme.colors.surface,
        }),
    },
    content: {
        paddingHorizontal: 16,
        paddingTop: 20,
        paddingBottom: 16,
    },
    title: {
        fontSize: 17,
        textAlign: 'center',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    inputRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginTop: 16,
        height: 38,
        paddingHorizontal: 10,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 8,
        backgroundColor: theme.colors.input.background,
    },
    input: {
        flex: 1,
        minWidth: 0,
        fontSize: 14,
        color: theme.colors.text,
        ...Typography.default(),
    },
    suggestionList: {
        marginTop: 8,
        maxHeight: 176,
    },
    suggestion: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingVertical: 9,
        paddingHorizontal: 6,
        borderRadius: 8,
    },
    suggestionPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    suggestionText: {
        flex: 1,
        minWidth: 0,
        fontSize: 14,
        color: theme.colors.text,
        ...Typography.default(),
    },
    buttonRow: {
        flexDirection: 'row',
        borderTopWidth: 1,
        borderTopColor: theme.colors.divider,
    },
    button: {
        flex: 1,
        paddingVertical: 11,
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttonPressed: {
        backgroundColor: theme.colors.divider,
    },
    buttonSeparator: {
        width: 1,
        backgroundColor: theme.colors.divider,
    },
    buttonText: {
        fontSize: 17,
        color: theme.colors.textLink,
        ...Typography.default(),
    },
    buttonTextConfirm: {
        ...Typography.default('semiBold'),
    },
}));
