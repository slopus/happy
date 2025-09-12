import * as React from "react";
import { View } from "react-native";
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
}

const flavorIcons = {
    claude: require('@/assets/images/icon-claude.png'),
    codex: require('@/assets/images/icon-gpt.png'),
    gemini: require('@/assets/images/icon-gemini.png'),
};

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
}));

export const Avatar = React.memo((props: AvatarProps) => {
    const { flavor, size = 48, ...avatarProps } = props;
    const avatarStyle = useSetting('avatarStyle');
    const showFlavorIcons = useSetting('showFlavorIcons');
    const { theme } = useUnistyles();
    
    // Determine which avatar variant to render
    let AvatarComponent: React.ComponentType<any>;
    if (avatarStyle === 'pixelated') {
        AvatarComponent = AvatarSkia;
    } else if (avatarStyle === 'brutalist') {
        AvatarComponent = AvatarBrutalist;
    } else {
        AvatarComponent = AvatarGradient;
    }
    
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
    
    // Only wrap in container if showing flavor icons
    if (showFlavorIcons) {
        return (
            <View style={[styles.container, { width: size, height: size }]}>
                <AvatarComponent {...avatarProps} size={size} />
                <View style={[styles.flavorIcon, { 
                    width: circleSize, 
                    height: circleSize,
                    alignItems: 'center',
                    justifyContent: 'center'
                }]}>
                    <Image
                        source={flavorIcon}
                        style={{ width: iconSize, height: iconSize, tintColor: effectiveFlavor === 'codex' ? theme.colors.text : undefined }}
                        contentFit="contain"
                        tintColor={effectiveFlavor === 'codex' ? theme.colors.text : undefined}
                    />
                </View>
            </View>
        );
    }
    
    // Return avatar without wrapper when not showing flavor icons
    return <AvatarComponent {...avatarProps} size={size} />;
});