import * as React from 'react';
import Svg, { Circle, Path } from 'react-native-svg';
import type { TaskPermissionLevel } from '@/utils/taskPermissionModes';

export function PermissionModeIcon({ level, color, size = 20 }: { level: TaskPermissionLevel | null; color: string; size?: number }) {
    return <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {level === 'confirm' ? <Path d="M8 13V5a1.5 1.5 0 0 1 3 0v6m0-6V3a1.5 1.5 0 0 1 3 0v8m0-6a1.5 1.5 0 0 1 3 0v7m0-4a1.5 1.5 0 0 1 3 0v7c0 4-2.4 7-6.2 7h-.6c-2.4 0-4.4-1.4-5.6-3.4L4 12.8a1.6 1.6 0 0 1 2.6-1.9L8 13" /> : <>
            <Path d="M12 2.5 21 7v6c0 5-4 8-9 9-5-1-9-4-9-9V7l9-4.5Z" />
            {level === 'full-access' ? <><Path d="M12 7.5v6" /><Circle cx={12} cy={17} r={0.8} fill={color} stroke="none" /></> : <><Path d="M8 9l3 3-3 3M14 15h3" /></>}
        </>}
    </Svg>;
}
