import * as React from "react";
import { View } from "react-native";
import { Image } from "expo-image";
import { AvatarSkia } from "./AvatarSkia";
import { AvatarGradient } from "./AvatarGradient";
import { AvatarBrutalist } from "./AvatarBrutalist";
import { useSetting } from '@/sync/storage';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { resolveAvatarHarness, type AvatarHarnessIcon } from '@/utils/avatarHarness';

export type AvatarBadgeLocation = 'sessionHeader' | 'sessionList' | 'none';

interface AvatarProps {
    id: string;
    title?: boolean;
    square?: boolean;
    size?: number;
    monochrome?: boolean;
    flavor?: string | null;
    clientId?: string | null;
    /** Where this avatar is rendered; omitted avatars never get a harness badge. */
    badgeLocation?: AvatarBadgeLocation;
    imageUrl?: string | null;
    thumbhash?: string | null;
}

const harnessIcons: Record<AvatarHarnessIcon, number> = {
    claude: require('@/assets/images/icon-claude.png'),
    codex: require('@/assets/images/icon-gpt.png'),
    agy: require('@/assets/images/icon-agy.png'),
    rig: require('@/assets/images/logo-black.png'),
};

const styles = StyleSheet.create((theme) => ({
    container: {
        position: 'relative',
    },
    harnessIcon: {
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
}));

export const Avatar = React.memo((props: AvatarProps) => {
    const { flavor, clientId, badgeLocation = 'none', size = 48, imageUrl, thumbhash, ...avatarProps } = props;
    const avatarStyle = useSetting('avatarStyle');
    const showFlavorIcons = useSetting('showFlavorIcons');
    const showHarnessIconInSessionHeader = useSetting('showHarnessIconInSessionHeader');
    const { theme } = useUnistyles();
    const showHarnessIcon = badgeLocation === 'sessionHeader'
        ? showHarnessIconInSessionHeader
        : badgeLocation === 'sessionList'
            ? showFlavorIcons
            : false;
    const effectiveHarness = resolveAvatarHarness(flavor, clientId);

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

        // Add harness icon overlay if enabled
        if (showHarnessIcon && effectiveHarness) {
            const harnessIcon = harnessIcons[effectiveHarness];
            const circleSize = Math.round(size * 0.35);
            const iconSize = effectiveHarness === 'codex'
                ? Math.round(size * 0.25)
                : effectiveHarness === 'claude'
                    ? Math.round(size * 0.28)
                    : effectiveHarness === 'rig'
                        ? Math.round(size * 0.29)
                        : Math.round(size * 0.35);

            return (
                <View style={[styles.container, { width: size, height: size }]}>
                    {imageElement}
                    <View style={[styles.harnessIcon, {
                        width: circleSize,
                        height: circleSize,
                        alignItems: 'center',
                        justifyContent: 'center'
                    }]}>
                        <Image
                            source={harnessIcon}
                            style={{ width: iconSize, height: iconSize }}
                            contentFit="contain"
                            tintColor={effectiveHarness === 'codex' || effectiveHarness === 'rig' ? theme.colors.text : undefined}
                        />
                    </View>
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

    // Determine harness icon for generated avatars
    const harnessIcon = effectiveHarness ? harnessIcons[effectiveHarness] : null;
    // Make icons smaller while keeping same circle size
    // Claude slightly bigger than codex
    const circleSize = Math.round(size * 0.35);
    const iconSize = effectiveHarness === 'codex'
        ? Math.round(size * 0.25)
        : effectiveHarness === 'claude'
            ? Math.round(size * 0.28)
            : effectiveHarness === 'rig'
                ? Math.round(size * 0.29)
                : Math.round(size * 0.35);

    // Only wrap in a container when this caller explicitly opts into a badge
    // location and the session has an identifiable harness.
    if (showHarnessIcon && effectiveHarness && harnessIcon) {
        return (
            <View style={[styles.container, { width: size, height: size }]}>
                <AvatarComponent {...avatarProps} size={size} />
                <View style={[styles.harnessIcon, {
                    width: circleSize,
                    height: circleSize,
                    alignItems: 'center',
                    justifyContent: 'center'
                }]}>
                    <Image
                        source={harnessIcon}
                        style={{ width: iconSize, height: iconSize }}
                        contentFit="contain"
                        tintColor={effectiveHarness === 'codex' || effectiveHarness === 'rig' ? theme.colors.text : undefined}
                    />
                </View>
            </View>
        );
    }

    // Return avatar without wrapper when not showing harness icons
    return <AvatarComponent {...avatarProps} size={size} />;
});
