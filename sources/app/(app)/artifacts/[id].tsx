import React from 'react';
import { View, ScrollView, ActivityIndicator, Pressable, Platform } from 'react-native';
import { Text } from '@/components/StyledText';
import { useArtifact } from '@/sync/storage';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';
import { layout } from '@/components/layout';
import { Ionicons } from '@expo/vector-icons';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { deleteArtifact } from '@/sync/apiArtifacts';
import { storage } from '@/sync/storage';

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
    errorIcon: {
        marginBottom: 16,
        color: theme.colors.textDestructive,
    },
    errorText: {
        fontSize: 16,
        color: theme.colors.text,
        textAlign: 'center',
    },
    titleContainer: {
        marginBottom: 24,
    },
    title: {
        fontSize: 24,
        fontWeight: '700',
        color: theme.colors.text,
        marginBottom: 8,
    },
    untitledTitle: {
        color: theme.colors.textSecondary,
        fontStyle: 'italic',
    },
    meta: {
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    bodyContainer: {
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        padding: 16,
        minHeight: 200,
    },
    body: {
        fontSize: 15,
        color: theme.colors.text,
        lineHeight: 22,
    },
    emptyBody: {
        color: theme.colors.textSecondary,
        fontStyle: 'italic',
    },
}));

export default function ArtifactDetailScreen() {
    const styles = stylesheet;
    const { id } = useLocalSearchParams<{ id: string }>();
    const router = useRouter();
    const artifact = useArtifact(id);
    const [isLoading, setIsLoading] = React.useState(!artifact?.body);
    const [isDeleting, setIsDeleting] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    // Load full artifact with body if not already loaded
    React.useEffect(() => {
        if (!artifact || artifact.body !== undefined) return;
        
        let cancelled = false;
        
        (async () => {
            try {
                setIsLoading(true);
                setError(null);
                
                const credentials = sync.getCredentials();
                if (!credentials) {
                    throw new Error('Not authenticated');
                }
                
                // Fetch full artifact with body
                const fullArtifact = await sync.fetchArtifactWithBody(id);
                if (!cancelled && fullArtifact) {
                    storage.getState().updateArtifact(fullArtifact);
                }
            } catch (err) {
                if (!cancelled) {
                    console.error('Failed to load artifact:', err);
                    setError(t('artifacts.error'));
                }
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

    const handleEdit = React.useCallback(() => {
        router.push(`/artifacts/edit/${id}`);
    }, [id, router]);

    const handleDelete = React.useCallback(async () => {
        const confirmed = await Modal.confirm(
            t('artifacts.deleteConfirm'),
            t('artifacts.deleteConfirmDescription'),
            {
                confirmText: t('artifacts.delete'),
                destructive: true,
            }
        );

        if (!confirmed) return;

        try {
            setIsDeleting(true);
            
            const credentials = sync.getCredentials();
            if (!credentials) {
                throw new Error('Not authenticated');
            }

            await deleteArtifact(credentials, id);
            storage.getState().deleteArtifact(id);
            
            // Navigate back
            router.back();
        } catch (err) {
            console.error('Failed to delete artifact:', err);
            Modal.alert(
                t('common.error'),
                'Failed to delete artifact'
            );
        } finally {
            setIsDeleting(false);
        }
    }, [id, router]);

    // Format date
    const formattedDate = React.useMemo(() => {
        if (!artifact) return '';
        return new Date(artifact.updatedAt).toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    }, [artifact]);

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

    if (error || !artifact) {
        return (
            <View style={styles.container}>
                <Stack.Screen 
                    options={{
                        headerShown: true,
                        headerTitle: t('common.error'),
                    }}
                />
                <View style={styles.errorContainer}>
                        <Ionicons 
                            name="alert-circle-outline" 
                            size={64} 
                            style={styles.errorIcon}
                        />
                        <Text style={styles.errorText}>
                            {error || t('artifacts.error')}
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
                    headerTitle: artifact.title || 'Untitled',
                    headerRight: () => (
                        <View style={{ flexDirection: 'row' }}>
                            <Pressable
                                onPress={handleEdit}
                                style={{ padding: 8, marginRight: 8 }}
                                disabled={isDeleting}
                            >
                                <Ionicons name="create-outline" size={22} color={styles.title.color} />
                            </Pressable>
                            <Pressable
                                onPress={handleDelete}
                                style={{ padding: 8 }}
                                disabled={isDeleting}
                            >
                                <Ionicons 
                                    name="trash-outline" 
                                    size={22} 
                                    color={isDeleting ? styles.meta.color : styles.errorIcon.color} 
                                />
                            </Pressable>
                        </View>
                    ),
                }}
            />
            <View style={styles.container}>
                <ScrollView 
                    style={styles.scrollView}
                    contentContainerStyle={[
                        styles.contentContainer,
                        { maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }
                    ]}
                >
                    <View style={styles.titleContainer}>
                        <Text 
                            style={[
                                styles.title,
                                !artifact.title && styles.untitledTitle
                            ]}
                        >
                            {artifact.title || 'Untitled'}
                        </Text>
                        <Text style={styles.meta}>
                            {formattedDate}
                        </Text>
                    </View>

                    <View style={styles.bodyContainer}>
                        <Text 
                            style={[
                                styles.body,
                                !artifact.body && styles.emptyBody
                            ]}
                            selectable={Platform.OS === 'web'}
                        >
                            {artifact.body || 'No content'}
                        </Text>
                    </View>
                </ScrollView>
            </View>
        </>
    );
}