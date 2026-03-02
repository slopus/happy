import * as React from 'react';
import { View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { useUnistyles } from 'react-native-unistyles';

const chatBubbleStarSvg = (color: string) => `
<svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M10 15C10 8.37 15.37 3 22 3H78C84.63 3 90 8.37 90 15V62C90 68.63 84.63 74 78 74H35L14 92C12.8 93.2 10.9 93.2 9.7 92C9.1 91.4 8.7 90.6 8.7 89.7V75.5C8.7 75.5 10 73 10 62V15Z" stroke="${color}" stroke-width="6.5" stroke-linejoin="round"/>
  <path d="M50 18L55.5 38L50 60L44.5 38L50 18Z" fill="${color}"/>
  <path d="M28 39L46 41L72 39L46 37L28 39Z" fill="${color}"/>
</svg>`;

/**
 * Shared header logo component used across all main tabs.
 * Extracted to prevent flickering on tab switches - when each tab
 * had its own HeaderLeft, the component would unmount/remount.
 */
export const HeaderLogo = React.memo(() => {
    const { theme } = useUnistyles();
    return (
        <View style={{
            width: 32,
            height: 32,
            alignItems: 'center',
            justifyContent: 'center',
        }}>
            <SvgXml
                xml={chatBubbleStarSvg(theme.colors.header.tint)}
                width={24}
                height={24}
            />
        </View>
    );
});
