import * as React from "react";
import { AvatarSkia } from "./AvatarSkia";
import { AvatarGradient } from "./AvatarGradient";
import { AvatarBrutalist } from "./AvatarBrutalist";
import { useSetting } from '@/sync/storage';

interface AvatarProps {
    id: string;
    title?: boolean;
    square?: boolean;
    size?: number;
    monochrome?: boolean;
}

export const Avatar = React.memo((props: AvatarProps) => {
    const avatarStyle = useSetting('avatarStyle');
    
    // Validate and provide fallback for unknown values
    if (avatarStyle === 'pixelated') {
        return <AvatarSkia {...props} />;
    }
    
    if (avatarStyle === 'brutalist') {
        return <AvatarBrutalist {...props} />;
    }
    
    // Default to gradient for any unknown value (including 'gradient')
    return <AvatarGradient {...props} />;
});