import React from 'react';
import { UserProfile, getDisplayName } from '@/sync/friendTypes';
import { Item } from '@/components/ui/lists/Item';
import { Avatar } from '@/components/Avatar';

interface UserCardProps {
    user: UserProfile;
    onPress?: () => void;
    disabled?: boolean;
    subtitle?: string;
}

export function UserCard({ 
    user, 
    onPress,
    disabled,
    subtitle
}: UserCardProps) {
    const displayName = getDisplayName(user);
    const avatarUrl = user.avatar?.url || user.avatar?.path;

    // Create avatar element using the Avatar component
    const avatarElement = (
        <Avatar
            id={user.id}
            size={40}
            imageUrl={avatarUrl}
            thumbhash={user.avatar?.thumbhash}
        />
    );

    // Create subtitle
    const subtitleText = subtitle ?? `@${user.username}`;

    return (
        <Item
            title={displayName}
            subtitle={subtitleText}
            subtitleLines={1}
            leftElement={avatarElement}
            onPress={onPress}
            showChevron={!!onPress}
            disabled={disabled}
        />
    );
}
