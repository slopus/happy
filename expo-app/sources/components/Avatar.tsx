import * as React from "react";
import { View } from "react-native";
import { Image } from "expo-image";
import { AvatarSkia } from "./AvatarSkia";
import { AvatarGradient } from "./AvatarGradient";
import { AvatarBrutalist } from "./AvatarBrutalist";
import { useSetting } from '@/sync/storage';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    DEFAULT_AGENT_ID,
    resolveAgentIdFromFlavor,
    getAgentAvatarOverlaySizes,
    getAgentIconSource,
    getAgentIconTintColor,
} from '@/agents/catalog';

interface AvatarProps {
    id: string;
    title?: boolean;
    square?: boolean;
    size?: number;
    monochrome?: boolean;
    flavor?: string | null;
    imageUrl?: string | null;
    thumbhash?: string | null;
    hasUnreadMessages?: boolean;
}

const styles = StyleSheet.create((theme) => ({
    container: {
        position: 'relative',
    },
    flavorIcon: {
        position: 'absolute',
        bottom: -2,
        right: -2,
        backgroundColor: theme.colors.surface,
        borderRadius: 100,
        padding: 2,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.2,
        shadowRadius: 2,
        elevation: 3,
    },
    unreadBadge: {
        position: 'absolute',
        top: -2,
        right: -2,
        backgroundColor: theme.colors.textLink,
        borderRadius: 100,
        borderWidth: 1.5,
        borderColor: theme.colors.surface,
    },
}));

export const Avatar = React.memo((props: AvatarProps) => {
    const { flavor, size = 48, imageUrl, thumbhash, hasUnreadMessages, ...avatarProps } = props;
    const avatarStyle = useSetting('avatarStyle');
    const showFlavorIcons = useSetting('showFlavorIcons');
    const { theme } = useUnistyles();

    const agentId = resolveAgentIdFromFlavor(flavor);

    const unreadBadgeSize = Math.round(size * 0.22);
    const unreadBadgeElement = hasUnreadMessages ? (
        <View style={[styles.unreadBadge, { width: unreadBadgeSize, height: unreadBadgeSize }]} />
    ) : null;

    // Render custom image if provided
    if (imageUrl) {
        const imageElement = (
            <Image
                source={{ uri: imageUrl, thumbhash: thumbhash || undefined }}
                placeholder={thumbhash ? { thumbhash: thumbhash } : undefined}
                contentFit="cover"
                style={{
                    width: size,
                    height: size,
                    borderRadius: avatarProps.square ? 0 : size / 2
                }}
            />
        );

            const showFlavorOverlay = Boolean(showFlavorIcons && agentId);
            if (showFlavorOverlay || hasUnreadMessages) {
            const iconAgentId = agentId ?? DEFAULT_AGENT_ID;
            const flavorIcon = getAgentIconSource(iconAgentId);
            const tintColor = getAgentIconTintColor(iconAgentId, theme);
            const { circleSize, iconSize } = getAgentAvatarOverlaySizes(iconAgentId, size);

            return (
                <View style={[styles.container, { width: size, height: size }]}>
                    {imageElement}
                {showFlavorOverlay && (
                        <View style={[styles.flavorIcon, {
                            width: circleSize,
                            height: circleSize,
                            alignItems: 'center',
                            justifyContent: 'center'
                        }]}>
                            <Image
                                source={flavorIcon}
                                style={{ width: iconSize, height: iconSize }}
                                contentFit="contain"
                                tintColor={tintColor}
                            />
                        </View>
                    )}
                    {unreadBadgeElement}
                </View>
            );
        }

        return imageElement;
    }

    // Original generated avatar logic
    // Determine which avatar variant to render
    let AvatarComponent: React.ComponentType<any>;
    if (avatarStyle === 'pixelated') {
        AvatarComponent = AvatarSkia;
    } else if (avatarStyle === 'brutalist') {
        AvatarComponent = AvatarBrutalist;
    } else {
        AvatarComponent = AvatarGradient;
    }

    const iconAgentId = agentId ?? DEFAULT_AGENT_ID;
    const flavorIcon = getAgentIconSource(iconAgentId);
    const tintColor = getAgentIconTintColor(iconAgentId, theme);
    const { circleSize, iconSize } = getAgentAvatarOverlaySizes(iconAgentId, size);

    if (showFlavorIcons || hasUnreadMessages) {
        return (
            <View style={[styles.container, { width: size, height: size }]}>
                <AvatarComponent {...avatarProps} size={size} />
                {showFlavorIcons && (
                    <View style={[styles.flavorIcon, {
                        width: circleSize,
                        height: circleSize,
                        alignItems: 'center',
                        justifyContent: 'center'
                    }]}>
                        <Image
                            source={flavorIcon}
                            style={{ width: iconSize, height: iconSize }}
                            contentFit="contain"
                            tintColor={tintColor}
                        />
                    </View>
                )}
                {unreadBadgeElement}
            </View>
        );
    }

    // Return avatar without wrapper when not showing flavor icons
    return <AvatarComponent {...avatarProps} size={size} />;
});
