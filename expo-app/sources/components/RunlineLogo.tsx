import * as React from 'react';
import Svg, { Rect, Path, G } from 'react-native-svg';
import { useUnistyles } from 'react-native-unistyles';

interface RunlineLogoProps {
    width?: number;
    height?: number;
}

/**
 * Runline logo in blocky pixel/terminal style
 * Automatically adapts to light/dark theme
 */
export function RunlineLogo({ width = 300, height = 90 }: RunlineLogoProps) {
    const { theme } = useUnistyles();
    const fillColor = theme.dark ? '#ffffff' : '#1a1a1a';

    // Scale factor based on width (original viewBox is 1050x160)
    const scale = width / 1050;
    const scaledHeight = 160 * scale;

    return (
        <Svg
            width={width}
            height={height || scaledHeight}
            viewBox="0 0 1050 160"
        >
            {/* R */}
            <G transform="translate(0, 0)">
                <Rect fill={fillColor} x="0" y="0" width="25" height="25"/>
                <Rect fill={fillColor} x="0" y="35" width="25" height="25"/>
                <Rect fill={fillColor} x="0" y="70" width="25" height="25"/>
                <Rect fill={fillColor} x="0" y="105" width="25" height="25"/>
                <Rect fill={fillColor} x="0" y="135" width="25" height="25"/>
                <Rect fill={fillColor} x="35" y="0" width="25" height="25"/>
                <Rect fill={fillColor} x="70" y="0" width="25" height="25"/>
                <Rect fill={fillColor} x="105" y="0" width="25" height="25"/>
                <Rect fill={fillColor} x="105" y="35" width="25" height="25"/>
                <Rect fill={fillColor} x="35" y="70" width="25" height="25"/>
                <Rect fill={fillColor} x="70" y="70" width="25" height="25"/>
                <Rect fill={fillColor} x="70" y="105" width="25" height="25"/>
                <Rect fill={fillColor} x="105" y="135" width="25" height="25"/>
            </G>

            {/* U */}
            <G transform="translate(150, 0)">
                <Rect fill={fillColor} x="0" y="0" width="25" height="25"/>
                <Rect fill={fillColor} x="0" y="35" width="25" height="25"/>
                <Rect fill={fillColor} x="0" y="70" width="25" height="25"/>
                <Rect fill={fillColor} x="0" y="105" width="25" height="25"/>
                <Rect fill={fillColor} x="35" y="135" width="25" height="25"/>
                <Rect fill={fillColor} x="70" y="135" width="25" height="25"/>
                <Rect fill={fillColor} x="105" y="0" width="25" height="25"/>
                <Rect fill={fillColor} x="105" y="35" width="25" height="25"/>
                <Rect fill={fillColor} x="105" y="70" width="25" height="25"/>
                <Rect fill={fillColor} x="105" y="105" width="25" height="25"/>
            </G>

            {/* N */}
            <G transform="translate(300, 0)">
                <Rect fill={fillColor} x="0" y="0" width="25" height="25"/>
                <Rect fill={fillColor} x="0" y="35" width="25" height="25"/>
                <Rect fill={fillColor} x="0" y="70" width="25" height="25"/>
                <Rect fill={fillColor} x="0" y="105" width="25" height="25"/>
                <Rect fill={fillColor} x="0" y="135" width="25" height="25"/>
                <Rect fill={fillColor} x="35" y="35" width="25" height="25"/>
                <Rect fill={fillColor} x="70" y="70" width="25" height="25"/>
                <Rect fill={fillColor} x="105" y="0" width="25" height="25"/>
                <Rect fill={fillColor} x="105" y="35" width="25" height="25"/>
                <Rect fill={fillColor} x="105" y="70" width="25" height="25"/>
                <Rect fill={fillColor} x="105" y="105" width="25" height="25"/>
                <Rect fill={fillColor} x="105" y="135" width="25" height="25"/>
            </G>

            {/* L */}
            <G transform="translate(450, 0)">
                <Rect fill={fillColor} x="0" y="0" width="25" height="25"/>
                <Rect fill={fillColor} x="0" y="35" width="25" height="25"/>
                <Rect fill={fillColor} x="0" y="70" width="25" height="25"/>
                <Rect fill={fillColor} x="0" y="105" width="25" height="25"/>
                <Rect fill={fillColor} x="0" y="135" width="25" height="25"/>
                <Rect fill={fillColor} x="35" y="135" width="25" height="25"/>
                <Rect fill={fillColor} x="70" y="135" width="25" height="25"/>
            </G>

            {/* I */}
            <G transform="translate(560, 0)">
                <Rect fill={fillColor} x="0" y="0" width="25" height="25"/>
                <Rect fill={fillColor} x="35" y="0" width="25" height="25"/>
                <Rect fill={fillColor} x="70" y="0" width="25" height="25"/>
                <Rect fill={fillColor} x="35" y="35" width="25" height="25"/>
                <Rect fill={fillColor} x="35" y="70" width="25" height="25"/>
                <Rect fill={fillColor} x="35" y="105" width="25" height="25"/>
                <Rect fill={fillColor} x="0" y="135" width="25" height="25"/>
                <Rect fill={fillColor} x="35" y="135" width="25" height="25"/>
                <Rect fill={fillColor} x="70" y="135" width="25" height="25"/>
            </G>

            {/* N */}
            <G transform="translate(680, 0)">
                <Rect fill={fillColor} x="0" y="0" width="25" height="25"/>
                <Rect fill={fillColor} x="0" y="35" width="25" height="25"/>
                <Rect fill={fillColor} x="0" y="70" width="25" height="25"/>
                <Rect fill={fillColor} x="0" y="105" width="25" height="25"/>
                <Rect fill={fillColor} x="0" y="135" width="25" height="25"/>
                <Rect fill={fillColor} x="35" y="35" width="25" height="25"/>
                <Rect fill={fillColor} x="70" y="70" width="25" height="25"/>
                <Rect fill={fillColor} x="105" y="0" width="25" height="25"/>
                <Rect fill={fillColor} x="105" y="35" width="25" height="25"/>
                <Rect fill={fillColor} x="105" y="70" width="25" height="25"/>
                <Rect fill={fillColor} x="105" y="105" width="25" height="25"/>
                <Rect fill={fillColor} x="105" y="135" width="25" height="25"/>
            </G>

            {/* E */}
            <G transform="translate(830, 0)">
                <Rect fill={fillColor} x="0" y="0" width="25" height="25"/>
                <Rect fill={fillColor} x="0" y="35" width="25" height="25"/>
                <Rect fill={fillColor} x="0" y="70" width="25" height="25"/>
                <Rect fill={fillColor} x="0" y="105" width="25" height="25"/>
                <Rect fill={fillColor} x="0" y="135" width="25" height="25"/>
                <Rect fill={fillColor} x="35" y="0" width="25" height="25"/>
                <Rect fill={fillColor} x="70" y="0" width="25" height="25"/>
                <Rect fill={fillColor} x="35" y="70" width="25" height="25"/>
                <Rect fill={fillColor} x="70" y="70" width="25" height="25"/>
                <Rect fill={fillColor} x="35" y="135" width="25" height="25"/>
                <Rect fill={fillColor} x="70" y="135" width="25" height="25"/>
            </G>
        </Svg>
    );
}

export default React.memo(RunlineLogo);
