import * as React from "react";
import { View, Text } from "react-native";
import { Image } from "expo-image";
import { AvatarSkia } from "./AvatarSkia";
import { AvatarGradient } from "./AvatarGradient";
import { AvatarBrutalist } from "./AvatarBrutalist";
import { useSetting } from '@/sync/storage';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

interface AvatarProps {
    id: string;
    title?: boolean;
    square?: boolean;
    size?: number;
    monochrome?: boolean;
    flavor?: string | null;
    imageUrl?: string | null;
    thumbhash?: string | null;
    sessionIcon?: string | null;  // preset key, image URL (http/https), or emoji
}

const flavorIcons = {
    claude: require('@/assets/images/icon-claude.png'),
    codex: require('@/assets/images/icon-gpt.png'),
    gemini: require('@/assets/images/icon-gemini.png'),
};

const sessionIconPresets: Record<string, any> = {
    dootask: require('@/assets/images/icon-dootask.png'),
};

export function resolveSessionIcon(value: string): { type: 'image'; source: any } | { type: 'emoji'; value: string } {
    if (value.startsWith('http://') || value.startsWith('https://')) {
        return { type: 'image', source: { uri: value } };
    }
    const preset = sessionIconPresets[value];
    if (preset) {
        return { type: 'image', source: preset };
    }
    return { type: 'emoji', value };
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
    sessionIconBadge: {
        position: 'absolute',
        bottom: -2,
        backgroundColor: theme.colors.surface,
        borderRadius: 100,
        padding: 2,
        overflow: 'hidden',
    },
}));

export const Avatar = React.memo((props: AvatarProps) => {
    const { flavor, size = 48, imageUrl, thumbhash, sessionIcon, ...avatarProps } = props;
    const avatarStyle = useSetting('avatarStyle');
    const showFlavorIcons = useSetting('showFlavorIcons');
    const { theme } = useUnistyles();

    // Determine flavor icon
    const effectiveFlavor = flavor || 'claude';
    const flavorIcon = flavorIcons[effectiveFlavor as keyof typeof flavorIcons] || flavorIcons.claude;
    // Make icons smaller while keeping same circle size
    // Claude slightly bigger than codex
    const circleSize = Math.round(size * 0.35);
    const iconSize = effectiveFlavor === 'codex'
        ? Math.round(size * 0.25)
        : effectiveFlavor === 'claude'
            ? Math.round(size * 0.28)
            : Math.round(size * 0.35);

    const renderSessionIconBadge = (offsetRight: number) => {
        if (!sessionIcon) return null;
        const resolved = resolveSessionIcon(sessionIcon);
        if (resolved.type === 'image') {
            return (
                <View style={[styles.sessionIconBadge, {
                    right: offsetRight,
                    width: circleSize,
                    height: circleSize,
                    alignItems: 'center',
                    justifyContent: 'center',
                }]}>
                    <Image
                        source={resolved.source}
                        style={{ width: circleSize - 4, height: circleSize - 4, borderRadius: 100 }}
                        contentFit="cover"
                    />
                </View>
            );
        }
        // Emoji
        return (
            <View style={[styles.sessionIconBadge, {
                right: offsetRight,
                width: circleSize,
                height: circleSize,
                alignItems: 'center',
                justifyContent: 'center',
            }]}>
                <Text style={{ fontSize: circleSize * 0.55 }}>{resolved.value}</Text>
            </View>
        );
    };

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

        const hasSessionIcon = !!sessionIcon;
        const hasFlavorIcon = showFlavorIcons && !!flavor;

        if (hasSessionIcon || hasFlavorIcon) {
            const sessionIconRight = hasFlavorIcon ? Math.round(circleSize * 0.55) : -2;
            return (
                <View style={[styles.container, { width: size, height: size }]}>
                    {imageElement}
                    {hasSessionIcon && renderSessionIconBadge(sessionIconRight)}
                    {hasFlavorIcon && (
                        <View style={[styles.flavorIcon, {
                            width: circleSize,
                            height: circleSize,
                            alignItems: 'center',
                            justifyContent: 'center',
                        }]}>
                            <Image
                                source={flavorIcon}
                                style={{ width: iconSize, height: iconSize }}
                                contentFit="contain"
                                tintColor={effectiveFlavor === 'codex' ? theme.colors.text : undefined}
                            />
                        </View>
                    )}
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

    const hasSessionIcon = !!sessionIcon;
    const hasFlavorIcon = !!showFlavorIcons; // Generated avatars always show flavor icon when setting is on

    if (hasSessionIcon || hasFlavorIcon) {
        // Compute offset: when both badges shown, sessionIcon shifts left
        const sessionIconRight = hasFlavorIcon ? Math.round(circleSize * 0.55) : -2;

        return (
            <View style={[styles.container, { width: size, height: size }]}>
                <AvatarComponent {...avatarProps} size={size} />
                {hasSessionIcon && renderSessionIconBadge(sessionIconRight)}
                {hasFlavorIcon && (
                    <View style={[styles.flavorIcon, {
                        width: circleSize,
                        height: circleSize,
                        alignItems: 'center',
                        justifyContent: 'center',
                    }]}>
                        <Image
                            source={flavorIcon}
                            style={{ width: iconSize, height: iconSize }}
                            contentFit="contain"
                            tintColor={effectiveFlavor === 'codex' ? theme.colors.text : undefined}
                        />
                    </View>
                )}
            </View>
        );
    }

    return <AvatarComponent {...avatarProps} size={size} />;
});