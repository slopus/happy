import * as React from 'react';
import { Platform } from 'react-native';

export type NativeOptionsPickerOption = {
    key: string;
    label: string;
};

export type NativeOptionsPickerProps = {
    title: string;
    triggerLabel: string;
    systemImage?: string;
    options: NativeOptionsPickerOption[];
    selectedKey: string | null | undefined;
    onSelect: (key: string) => void;
    /** Called as the native trigger begins handling a touch. */
    onMenuOpen?: () => void;
    /**
     * Overrides the native trigger label color. Without an override the label
     * follows theme.colors.text.
     */
    tintColor?: string;
    children: React.ReactNode;
};

const NativeOptionsPickerImpl = Platform.select<React.ComponentType<NativeOptionsPickerProps>>({
    ios: require('./NativeOptionsPicker.ios').NativeOptionsPicker,
    android: require('./NativeOptionsPicker.android').NativeOptionsPicker,
    default: require('./NativeOptionsPicker.web').NativeOptionsPicker,
}) ?? require('./NativeOptionsPicker.web').NativeOptionsPicker;

export function NativeOptionsPicker(props: NativeOptionsPickerProps) {
    return <NativeOptionsPickerImpl {...props} />;
}
