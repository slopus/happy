import * as React from 'react';
import { View } from 'react-native';
import type { NativeSettingsMenuProps } from './NativeSettingsMenu';

export function NativeSettingsMenu({ children, style }: NativeSettingsMenuProps) {
    return <View style={style}>{children}</View>;
}
