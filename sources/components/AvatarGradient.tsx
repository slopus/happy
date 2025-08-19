import * as React from "react";
import { Image } from "expo-image";

// Copy hashCode function for consistency with Avatar.tsx
function hashCode(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return Math.abs(hash);
}

// Array of all 100 gradient images
const gradientImages = [
    require('@/assets/images/gradients/01.png'),
    require('@/assets/images/gradients/02.png'),
    require('@/assets/images/gradients/03.png'),
    require('@/assets/images/gradients/04.png'),
    require('@/assets/images/gradients/05.png'),
    require('@/assets/images/gradients/06.png'),
    require('@/assets/images/gradients/07.png'),
    require('@/assets/images/gradients/08.png'),
    require('@/assets/images/gradients/09.png'),
    require('@/assets/images/gradients/10.png'),
    require('@/assets/images/gradients/11.png'),
    require('@/assets/images/gradients/12.png'),
    require('@/assets/images/gradients/13.png'),
    require('@/assets/images/gradients/14.png'),
    require('@/assets/images/gradients/15.png'),
    require('@/assets/images/gradients/16.png'),
    require('@/assets/images/gradients/17.png'),
    require('@/assets/images/gradients/18.png'),
    require('@/assets/images/gradients/19.png'),
    require('@/assets/images/gradients/20.png'),
    require('@/assets/images/gradients/21.png'),
    require('@/assets/images/gradients/22.png'),
    require('@/assets/images/gradients/23.png'),
    require('@/assets/images/gradients/24.png'),
    require('@/assets/images/gradients/25.png'),
    require('@/assets/images/gradients/26.png'),
    require('@/assets/images/gradients/27.png'),
    require('@/assets/images/gradients/28.png'),
    require('@/assets/images/gradients/29.png'),
    require('@/assets/images/gradients/30.png'),
    require('@/assets/images/gradients/31.png'),
    require('@/assets/images/gradients/32.png'),
    require('@/assets/images/gradients/33.png'),
    require('@/assets/images/gradients/34.png'),
    require('@/assets/images/gradients/35.png'),
    require('@/assets/images/gradients/36.png'),
    require('@/assets/images/gradients/37.png'),
    require('@/assets/images/gradients/38.png'),
    require('@/assets/images/gradients/39.png'),
    require('@/assets/images/gradients/40.png'),
    require('@/assets/images/gradients/41.png'),
    require('@/assets/images/gradients/42.png'),
    require('@/assets/images/gradients/43.png'),
    require('@/assets/images/gradients/44.png'),
    require('@/assets/images/gradients/45.png'),
    require('@/assets/images/gradients/46.png'),
    require('@/assets/images/gradients/47.png'),
    require('@/assets/images/gradients/48.png'),
    require('@/assets/images/gradients/49.png'),
    require('@/assets/images/gradients/50.png'),
    require('@/assets/images/gradients/51.png'),
    require('@/assets/images/gradients/52.png'),
    require('@/assets/images/gradients/53.png'),
    require('@/assets/images/gradients/54.png'),
    require('@/assets/images/gradients/55.png'),
    require('@/assets/images/gradients/56.png'),
    require('@/assets/images/gradients/57.png'),
    require('@/assets/images/gradients/58.png'),
    require('@/assets/images/gradients/59.png'),
    require('@/assets/images/gradients/60.png'),
    require('@/assets/images/gradients/61.png'),
    require('@/assets/images/gradients/62.png'),
    require('@/assets/images/gradients/63.png'),
    require('@/assets/images/gradients/64.png'),
    require('@/assets/images/gradients/65.png'),
    require('@/assets/images/gradients/66.png'),
    require('@/assets/images/gradients/67.png'),
    require('@/assets/images/gradients/68.png'),
    require('@/assets/images/gradients/69.png'),
    require('@/assets/images/gradients/70.png'),
    require('@/assets/images/gradients/71.png'),
    require('@/assets/images/gradients/72.png'),
    require('@/assets/images/gradients/73.png'),
    require('@/assets/images/gradients/74.png'),
    require('@/assets/images/gradients/75.png'),
    require('@/assets/images/gradients/76.png'),
    require('@/assets/images/gradients/77.png'),
    require('@/assets/images/gradients/78.png'),
    require('@/assets/images/gradients/79.png'),
    require('@/assets/images/gradients/80.png'),
    require('@/assets/images/gradients/81.png'),
    require('@/assets/images/gradients/82.png'),
    require('@/assets/images/gradients/83.png'),
    require('@/assets/images/gradients/84.png'),
    require('@/assets/images/gradients/85.png'),
    require('@/assets/images/gradients/86.png'),
    require('@/assets/images/gradients/87.png'),
    require('@/assets/images/gradients/88.png'),
    require('@/assets/images/gradients/89.png'),
    require('@/assets/images/gradients/90.png'),
    require('@/assets/images/gradients/91.png'),
    require('@/assets/images/gradients/92.png'),
    require('@/assets/images/gradients/93.png'),
    require('@/assets/images/gradients/94.png'),
    require('@/assets/images/gradients/95.png'),
    require('@/assets/images/gradients/96.png'),
    require('@/assets/images/gradients/97.png'),
    require('@/assets/images/gradients/98.png'),
    require('@/assets/images/gradients/99.png'),
    require('@/assets/images/gradients/100.png'),
];

interface AvatarGradientProps {
    id: string;
    title?: boolean;
    square?: boolean;
    size?: number;
    monochrome?: boolean;
}

export const AvatarGradient = React.memo((props: AvatarGradientProps) => {
    const { id, square, size = 48, monochrome } = props;
    
    // Use hashCode to get consistent gradient index
    const imageIndex = hashCode(id) % 100;
    const gradientImage = gradientImages[imageIndex];
    
    return (
        <Image
            source={gradientImage}
            style={{
                width: size,
                height: size,
                borderRadius: square ? 0 : size / 2,
            }}
            contentFit="cover"
            // Apply grayscale tint for monochrome mode
            // tintColor={monochrome ? '#808080' : undefined}
        />
    );
});