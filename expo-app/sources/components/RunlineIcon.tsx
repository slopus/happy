import * as React from 'react';
import Svg, { Rect } from 'react-native-svg';

interface RunlineIconProps {
    size?: number;
    color?: string;
}

/**
 * Runline "R" icon in blocky pixel/terminal style
 * Matches the aesthetic of the original Happy "H" icon
 */
export function RunlineIcon({ size = 24, color = '#1a1a1a' }: RunlineIconProps) {
    return (
        <Svg width={size} height={size} viewBox="0 0 100 100">
            {/* Left vertical bar */}
            <Rect fill={color} x="10" y="5" width="20" height="20"/>
            <Rect fill={color} x="10" y="30" width="20" height="20"/>
            <Rect fill={color} x="10" y="55" width="20" height="20"/>
            <Rect fill={color} x="10" y="80" width="20" height="15"/>

            {/* Top horizontal */}
            <Rect fill={color} x="35" y="5" width="20" height="20"/>
            <Rect fill={color} x="60" y="5" width="20" height="20"/>

            {/* Right side of bump */}
            <Rect fill={color} x="85" y="5" width="10" height="20"/>
            <Rect fill={color} x="85" y="30" width="10" height="15"/>

            {/* Middle horizontal */}
            <Rect fill={color} x="35" y="50" width="20" height="20"/>
            <Rect fill={color} x="60" y="50" width="15" height="20"/>

            {/* Diagonal leg */}
            <Rect fill={color} x="60" y="75" width="15" height="20"/>
            <Rect fill={color} x="80" y="80" width="15" height="15"/>
        </Svg>
    );
}

export default React.memo(RunlineIcon);
