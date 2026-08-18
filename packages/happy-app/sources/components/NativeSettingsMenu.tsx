import * as React from 'react';
import { Platform, type StyleProp, type ViewStyle } from 'react-native';

export type NativeSettingsMenuOption = {
    key: string;
    label: string;
    disabled?: boolean;
};

export type NativeSettingsMenuGroup = {
    key: string;
    /** The current value, shown on the trigger. */
    label: string;
    /** What is being chosen, shown as the heading above the options. */
    title?: string;
    systemImage?: string;
    options: NativeSettingsMenuOption[];
    selectedKey: string | null | undefined;
    onSelect: (key: string) => void;
};

export type NativeSettingsMenuProps = {
    groups: NativeSettingsMenuGroup[];
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    accessibilityLabel?: string;
    /** Render all options directly in the root menu without native section headers. */
    flat?: boolean;
    /**
     * Draw the trigger with SwiftUI instead of layering an invisible hit target
     * over the React Native child. iOS morphs a menu's trigger into the menu and
     * lenses whatever sits beneath it, so a React Native chip under the trigger
     * is visibly distorted every time the menu opens or closes; a native trigger
     * morphs cleanly. These must mirror the child exactly rather than decorate
     * it: the child is kept for layout and hidden.
     */
    triggerLabel?: string;
    triggerSystemImage?: string;
    triggerAlignment?: 'leading' | 'trailing' | 'center';
};

const NativeSettingsMenuImpl = Platform.select<React.ComponentType<NativeSettingsMenuProps>>({
    ios: require('./NativeSettingsMenu.ios').NativeSettingsMenu,
    android: require('./NativeSettingsMenu.android').NativeSettingsMenu,
    default: require('./NativeSettingsMenu.web').NativeSettingsMenu,
}) ?? require('./NativeSettingsMenu.web').NativeSettingsMenu;

export function NativeSettingsMenu(props: NativeSettingsMenuProps) {
    return <NativeSettingsMenuImpl {...props} />;
}
