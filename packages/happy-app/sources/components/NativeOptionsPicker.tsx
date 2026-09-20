import * as React from 'react';
import { Platform } from 'react-native';

export type NativeOptionsPickerOption = {
    key: string;
    label: string;
    disabled?: boolean;
    /**
     * An action rather than a choice, such as "Enter custom path…". It is never
     * drawn as the selection and never takes the check column.
     */
    action?: boolean;
};

export type NativeOptionsPickerSection = {
    key: string;
    /**
     * Heading the system draws above the options, the way the model menu names
     * each provider. Leave it out for a bare group such as a lone action.
     */
    title?: string;
    options: NativeOptionsPickerOption[];
};

export type NativeOptionsPickerProps = {
    /** What is being chosen. Read out with the value, and the prompt on web. */
    title: string;
    triggerLabel: string;
    sections: NativeOptionsPickerSection[];
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
