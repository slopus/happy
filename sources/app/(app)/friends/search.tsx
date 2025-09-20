import React, { useState, useCallback } from 'react';
import { View, Text, TextInput, ActivityIndicator, KeyboardAvoidingView, Platform, FlatList } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { UserSearchResult } from '@/components/UserSearchResult';
import { searchUsersByUsername, sendFriendRequest } from '@/sync/apiFriends';
import { useAuth } from '@/auth/AuthContext';
import { UserProfile } from '@/sync/friendTypes';
import { Modal } from '@/modal';
import { t } from '@/text';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { useSearch } from '@/hooks/useSearch';

export default function SearchFriendsScreen() {
    const { credentials } = useAuth();
    const [searchQuery, setSearchQuery] = useState('');
    const [processingUserId, setProcessingUserId] = useState<string | null>(null);
    
    // Use the new search hook
    const { results: searchResults, isSearching } = useSearch(
        searchQuery,
        useCallback((query: string) => {
            if (!credentials) {
                return Promise.resolve([]);
            }
            return searchUsersByUsername(credentials, query.trim());
        }, [credentials])
    );
    
    const handleAddFriend = useCallback(async (user: UserProfile) => {
        if (!credentials) return;

        setProcessingUserId(user.id);
        try {
            const updatedProfile = await sendFriendRequest(credentials, user.id);
            
            if (updatedProfile) {
                console.log(t('friends.requestSent'));
            } else {
                await Modal.alert(t('friends.bothMustHaveGithub'));
            }
        } catch (error: any) {
            console.error('Failed to send friend request:', error);
            if (error.message?.includes('yourself')) {
                await Modal.alert(t('friends.cannotAddYourself'));
            } else {
                await Modal.alert(t('errors.failedToSendRequest'));
            }
        } finally {
            setProcessingUserId(null);
        }
    }, [credentials]);

    const renderUserItem = ({ item }: { item: UserProfile }) => (
        <UserSearchResult
            user={item}
            onAddFriend={() => handleAddFriend(item)}
            isProcessing={processingUserId === item.id}
        />
    );

    const renderSeparator = () => (
        <View style={styles.separator} />
    );
    
    const hasSearched = searchQuery.trim().length > 0;

    return (
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
            <ItemList
                style={{ paddingTop: 0 }}
                keyboardShouldPersistTaps="handled"
            >
                <ItemGroup
                    title={t('friends.searchInstructions')}
                    style={styles.searchSection}
                >
                    <View style={styles.searchContainer}>
                        <TextInput
                            style={styles.searchInput}
                            placeholder={t('friends.searchPlaceholder')}
                            placeholderTextColor="#999999"
                            value={searchQuery}
                            onChangeText={setSearchQuery}
                            autoCapitalize="none"
                            autoCorrect={false}
                            returnKeyType="search"
                            editable={!processingUserId}
                        />
                        
                        {isSearching && (
                            <View style={styles.searchingIndicator}>
                                <ActivityIndicator size="small" color="#2BACCC" />
                            </View>
                        )}
                    </View>
                </ItemGroup>

                <ItemGroup
                    style={styles.resultsGroup}
                >
                    <View style={styles.resultsSection}>
                        {isSearching && searchResults.length === 0 ? (
                            <View style={styles.loadingContainer}>
                                <ActivityIndicator size="large" color="#2BACCC" />
                                <Text style={styles.loadingText}>{t('friends.searching')}</Text>
                            </View>
                        ) : searchResults.length > 0 ? (
                            <FlatList
                                data={searchResults}
                                renderItem={renderUserItem}
                                ItemSeparatorComponent={renderSeparator}
                                keyExtractor={(item) => item.id}
                                scrollEnabled={false}
                                contentContainerStyle={styles.resultsList}
                            />
                        ) : hasSearched ? (
                            <View style={styles.noResultsContainer}>
                                <Text style={styles.noResultsText}>
                                    {t('friends.noUserFound')}
                                </Text>
                                <Text style={styles.noResultsHint}>
                                    {t('friends.checkUsername')}
                                </Text>
                            </View>
                        ) : (
                            <View style={styles.helpContainer}>
                                <Text style={styles.helpTitle}>
                                    {t('friends.howToFind')}
                                </Text>
                                <Text style={styles.helpText}>
                                    {t('friends.findInstructions')}
                                </Text>
                            </View>
                        )}
                    </View>
                </ItemGroup>
            </ItemList>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    searchSection: {
        marginBottom: 16,
    },
    searchContainer: {
        paddingHorizontal: 16,
        paddingVertical: 8,
        position: 'relative',
    },
    searchInput: {
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 12,
        paddingHorizontal: 16,
        paddingVertical: 16,
        fontSize: 16,
        color: theme.colors.text,
    },
    searchingIndicator: {
        position: 'absolute',
        right: 32,
        top: 0,
        bottom: 0,
        justifyContent: 'center',
    },
    resultsGroup: {
        marginBottom: 16,
    },
    resultsSection: {
        minHeight: 200,
    },
    resultsList: {
        paddingVertical: 8,
    },
    separator: {
        height: 1,
        backgroundColor: theme.colors.divider,
        marginHorizontal: 16,
        marginVertical: 8,
    },
    loadingContainer: {
        alignItems: 'center',
        padding: 32,
    },
    loadingText: {
        marginTop: 16,
        fontSize: 16,
        color: theme.colors.textSecondary,
    },
    noResultsContainer: {
        alignItems: 'center',
        padding: 32,
    },
    noResultsText: {
        fontSize: 16,
        color: theme.colors.textSecondary,
        marginBottom: 8,
    },
    noResultsHint: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
    helpContainer: {
        padding: 32,
        alignItems: 'center',
    },
    helpTitle: {
        fontSize: 17,
        fontWeight: '600',
        color: theme.colors.text,
        marginBottom: 16,
    },
    helpText: {
        fontSize: 15,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        lineHeight: 22,
    },
}));