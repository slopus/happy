import * as React from 'react';
import Svg, { Path, Rect } from 'react-native-svg';

/** Optical geometry shared by the send and running-task actions. */
export function ComposerActionIcon({ stop, color, size = 24 }: { stop: boolean; color: string; size?: number }) {
    return <Svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
        {stop
            ? <Rect x={6} y={6} width={12} height={12} rx={2} fill={color} />
            : <Path d="M12 20V4M5 11l7-7 7 7" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />}
    </Svg>;
}
