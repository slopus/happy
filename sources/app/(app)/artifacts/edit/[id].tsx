import React from 'react';
import { View, ScrollView, TextInput, Pressable, ActivityIndicator, Platform, KeyboardAvoidingView as RNKeyboardAvoidingView } from 'react-native';
import { Text } from '@/components/StyledText';
import { useRouter, Stack, useLocalSearchParams } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { layout } from '@/components/layout';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useArtifact } from '@/sync/storage';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    scrollView: {
        flex: 1,
    },
    contentContainer: {
        padding: 16,
        paddingBottom: 100,
    },
    loadingContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    errorContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 32,
    },
    errorText: {
        fontSize: 16,
        color: theme.colors.text,
        textAlign: 'center',
    },
    inputGroup: {
        marginBottom: 24,
    },
    label: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        marginBottom: 8,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
    },
    input: {
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        paddingHorizontal: 16,
        paddingVertical: 14,
        fontSize: 16,
        color: theme.colors.text,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    } as any,
    inputFocused: {
        borderColor: theme.colors.button.primary.background,
    },
    textArea: {
        minHeight: 200,
        textAlignVertical: 'top',
        paddingTop: 14,
        lineHeight: 22,
    },
    headerButton: {
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
    headerButtonText: {
        fontSize: 17,
        fontWeight: '600',
        color: theme.colors.header.tint,
    },
    headerButtonDisabled: {
        opacity: 0.5,
    },
}));

export default function EditArtifactScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const { id } = useLocalSearchParams<{ id: string }>();
    const artifact = useArtifact(id);
    
    const [title, setTitle] = React.useState('');
    const [body, setBody] = React.useState('');
    const [isSaving, setIsSaving] = React.useState(false);
    const [isLoading, setIsLoading] = React.useState(true);
    const [hasChanges, setHasChanges] = React.useState(false);
    const [titleFocused, setTitleFocused] = React.useState(false);
    const [bodyFocused, setBodyFocused] = React.useState(false);
    
    // Load full artifact with body if needed
    React.useEffect(() => {
        if (!artifact) {
            setIsLoading(false);
            return;
        }
        
        let cancelled = false;
        
        (async () => {
            try {
                // If body is not loaded, fetch it
                if (artifact.body === undefined) {
                    const fullArtifact = await sync.fetchArtifactWithBody(id);
                    if (!cancelled && fullArtifact) {
                        setTitle(fullArtifact.title || '');
                        setBody(fullArtifact.body || '');
                    }
                } else {
                    setTitle(artifact.title || '');
                    setBody(artifact.body || '');
                }
            } catch (err) {
                console.error('Failed to load artifact for editing:', err);
            } finally {
                if (!cancelled) {
                    setIsLoading(false);
                }
            }
        })();
        
        return () => {
            cancelled = true;
        };
    }, [id, artifact]);
    
    // Track changes
    React.useEffect(() => {
        if (artifact) {
            const titleChanged = (title || null) !== artifact.title;
            const bodyChanged = (body || null) !== artifact.body;
            setHasChanges(titleChanged || bodyChanged);
        }
    }, [title, body, artifact]);
    
    const handleSave = React.useCallback(async () => {
        if (isSaving || !hasChanges) return;
        
        // At least one field should have content
        if (!title.trim() && !body.trim()) {
            await Modal.alert(
                t('common.error'),
                t('artifacts.emptyFieldsError')
            );
            return;
        }
        
        try {
            setIsSaving(true);
            
            // Update the artifact
            await sync.updateArtifact(
                id,
                title.trim() || null,
                body.trim() || null
            );
            
            // Navigate back
            router.back();
        } catch (err) {
            console.error('Failed to update artifact:', err);
            await Modal.alert(
                t('common.error'),
                t('artifacts.updateError')
            );
            setIsSaving(false);
        }
    }, [id, title, body, hasChanges, isSaving, router]);
    
    const HeaderRight = React.useCallback(() => (
        <Pressable
            style={[styles.headerButton, (!hasChanges || isSaving) && styles.headerButtonDisabled]}
            onPress={handleSave}
            disabled={!hasChanges || isSaving}
        >
            {isSaving ? (
                <ActivityIndicator size="small" color={theme.colors.header.tint} />
            ) : (
                <Text style={styles.headerButtonText}>
                    {t('common.save')}
                </Text>
            )}
        </Pressable>
    ), [handleSave, hasChanges, isSaving, styles]);
    
    const KeyboardWrapper = Platform.select({
        ios: KeyboardAvoidingView,
        default: React.Fragment,
    });
    
    const keyboardProps = Platform.select({
        ios: {
            behavior: 'padding' as const,
            keyboardVerticalOffset: 0,
        },
        default: {},
    });
    
    if (isLoading) {
        return (
            <View style={styles.container}>
                <Stack.Screen 
                    options={{
                        headerShown: true,
                        headerTitle: t('artifacts.loading'),
                    }}
                />
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" />
                </View>
            </View>
        );
    }
    
    if (!artifact) {
        return (
            <View style={styles.container}>
                <Stack.Screen 
                    options={{
                        headerShown: true,
                        headerTitle: t('common.error'),
                    }}
                />
                <View style={styles.errorContainer}>
                    <Text style={styles.errorText}>
                        {t('artifacts.notFound')}
                    </Text>
                </View>
            </View>
        );
    }
    
    return (
        <>
            <Stack.Screen 
                options={{
                    headerShown: true,
                    headerTitle: t('artifacts.edit'),
                    headerRight: HeaderRight,
                }}
            />
            <View style={styles.container}>
                <KeyboardWrapper {...keyboardProps}>
                    <ScrollView 
                        style={styles.scrollView}
                        contentContainerStyle={[
                            styles.contentContainer,
                            { maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }
                        ]}
                        keyboardShouldPersistTaps="handled"
                    >
                        <View style={styles.inputGroup}>
                            <Text style={styles.label}>{t('artifacts.titleLabel')}</Text>
                            <TextInput
                                style={[
                                    styles.input,
                                    titleFocused && styles.inputFocused,
                                    Platform.OS === 'web' && { 
                                        outlineStyle: 'none',
                                        outline: 'none',
                                        outlineWidth: 0,
                                        outlineColor: 'transparent'
                                    } as any
                                ]}
                                value={title}
                                onChangeText={setTitle}
                                placeholder={t('artifacts.titlePlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                onFocus={() => setTitleFocused(true)}
                                onBlur={() => setTitleFocused(false)}
                                editable={!isSaving}
                                returnKeyType="next"
                                autoCapitalize="sentences"
                            />
                        </View>
                        
                        <View style={styles.inputGroup}>
                            <Text style={styles.label}>{t('artifacts.bodyLabel')}</Text>
                            <TextInput
                                style={[
                                    styles.input,
                                    styles.textArea,
                                    bodyFocused && styles.inputFocused,
                                    Platform.OS === 'web' && { 
                                        outlineStyle: 'none',
                                        outline: 'none',
                                        outlineWidth: 0,
                                        outlineColor: 'transparent'
                                    } as any
                                ]}
                                value={body}
                                onChangeText={setBody}
                                placeholder={t('artifacts.bodyPlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                onFocus={() => setBodyFocused(true)}
                                onBlur={() => setBodyFocused(false)}
                                editable={!isSaving}
                                multiline
                                numberOfLines={10}
                                autoCapitalize="sentences"
                            />
                        </View>
                    </ScrollView>
                </KeyboardWrapper>
            </View>
        </>
    );
}