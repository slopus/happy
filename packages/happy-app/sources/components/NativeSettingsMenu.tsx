import * as React from 'react';
import { Platform, type StyleProp, type ViewStyle } from 'react-native';

export type NativeSettingsMenuOption = {
    key: string;
    label: string;
};

export type NativeSettingsMenuGroup = {
    key: string;
    label: string;
    systemImage?: string;
    options: NativeSettingsMenuOption[];
    selectedKey: string | null | undefined;
    onSelect: (key: string) => void;
};

export type NativeSettingsMenuProps = {
    groups: NativeSettingsMenuGroup[];
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    /** Render all options directly in the root menu instead of nesting by group. */
    flat?: boolean;
};

const NativeSettingsMenuImpl = Platform.select<React.ComponentType<NativeSettingsMenuProps>>({
    ios: require('./NativeSettingsMenu.ios').NativeSettingsMenu,
    android: require('./NativeSettingsMenu.android').NativeSettingsMenu,
    default: require('./NativeSettingsMenu.web').NativeSettingsMenu,
}) ?? require('./NativeSettingsMenu.web').NativeSettingsMenu;

export function NativeSettingsMenu(props: NativeSettingsMenuProps) {
    return <NativeSettingsMenuImpl {...props} />;
}
