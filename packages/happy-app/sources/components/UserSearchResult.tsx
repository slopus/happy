import React from 'react';
import { Platform, View, Text, TouchableOpacity, ActivityIndicator, Pressable } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { UserProfile, getDisplayName } from '@/sync/friendTypes';
import { Avatar } from '@/components/Avatar';
import { t } from '@/text';
import { useRouter } from 'expo-router';
import { MobileGlassSurface } from '@/components/MobileGlass';

interface UserSearchResultProps {
    user: UserProfile;
    onAddFriend: () => void;
    isProcessing?: boolean;
}

export function UserSearchResult({ 
    user, 
    onAddFriend, 
    isProcessing = false 
}: UserSearchResultProps) {
    const router = useRouter();
    const displayName = getDisplayName(user);
    const avatarUrl = user.avatar?.url || user.avatar?.path;
    
    // Determine button state based on relationship status
    const getButtonContent = () => {
        if (isProcessing) {
            return <ActivityIndicator size="small" color="white" />;
        }
        
        switch (user.status) {
            case 'friend':
                return <Text style={styles.buttonTextDisabled}>{t('friends.alreadyFriends')}</Text>;
            case 'pending':
                return <Text style={styles.buttonTextDisabled}>{t('friends.requestPending')}</Text>;
            case 'requested':
                return <Text style={styles.buttonTextDisabled}>{t('friends.requestSent')}</Text>;
            default:
                return <Text style={styles.buttonText}>{t('friends.addFriend')}</Text>;
        }
    };
    
    const isDisabled = isProcessing || user.status === 'friend' || user.status === 'pending' || user.status === 'requested';

    return (
        <Pressable
            style={styles.container}
            onPress={() => router.push(`/user/${user.id}`)}
        >
            <MobileGlassSurface enabled={Platform.OS !== 'web'} intensity={64} style={styles.glassCard}>
            <View style={styles.content}>
                <Avatar
                    id={user.id}
                    size={48}
                    imageUrl={avatarUrl}
                    thumbhash={user.avatar?.thumbhash}
                />
                
                <View style={styles.info}>
                    <Text style={styles.name}>{displayName}</Text>
                    <Text style={styles.username}>@{user.username}</Text>
                </View>

                <TouchableOpacity
                    style={[
                        styles.button, 
                        isDisabled && styles.buttonDisabled
                    ]}
                    onPress={onAddFriend}
                    disabled={isDisabled}
                >
                    {getButtonContent()}
                </TouchableOpacity>
            </View>
            </MobileGlassSurface>
        </Pressable>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        marginHorizontal: 16,
        marginVertical: 4,
        backgroundColor: Platform.select({ web: theme.colors.surface, default: 'transparent' }),
        borderRadius: Platform.select({ web: 12, default: 18 }),
        overflow: Platform.select({ web: 'visible', default: 'hidden' }),
        shadowColor: Platform.select({ web: '#000', default: 'transparent' }),
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: Platform.select({ web: 0.05, default: 0 }),
        shadowRadius: Platform.select({ web: 2, default: 0 }),
        elevation: Platform.select({ web: 2, default: 0 }),
    },
    glassCard: {
        borderRadius: Platform.select({ web: 0, default: 18 }),
        overflow: Platform.select({ web: 'visible', default: 'hidden' }),
        backgroundColor: Platform.select({ web: 'transparent', android: theme.colors.glass.backgroundStrong, default: 'transparent' }),
        borderWidth: Platform.select({ web: 0, default: StyleSheet.hairlineWidth }),
        borderColor: theme.colors.glass.border,
    },
    content: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 16,
    },
    info: {
        flex: 1,
        marginLeft: 16,
    },
    name: {
        fontSize: 16,
        fontWeight: '600',
        color: theme.colors.text,
        marginBottom: 2,
    },
    username: {
        fontSize: 14,
        color: theme.colors.textSecondary,
    },
    button: {
        backgroundColor: Platform.select({ web: theme.colors.button.primary.background, default: theme.colors.glass.backgroundSubtle }),
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 8,
        minWidth: 100,
        alignItems: 'center',
        borderWidth: Platform.select({ web: 0, default: StyleSheet.hairlineWidth }),
        borderColor: Platform.select({ web: 'transparent', default: theme.colors.glass.border }),
    },
    buttonDisabled: {
        backgroundColor: theme.colors.divider,
    },
    buttonText: {
        color: Platform.select({ web: theme.colors.button.primary.tint, default: theme.colors.textLink }),
        fontSize: 14,
        fontWeight: '600',
    },
    buttonTextDisabled: {
        color: theme.colors.textSecondary,
        fontSize: 14,
        fontWeight: '500',
    },
}));
