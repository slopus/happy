/*
 * What every platform's segmented control shares, in a file with no platform
 * suffix. Metro resolves an extensionless `./NativeSegmentedControl` from the
 * iOS file back to the iOS file itself, so a runtime value the iOS control
 * needs cannot live in the base implementation.
 */

export type NativeSegmentedControlOption = {
    key: string;
    label: string;
};

export type NativeSegmentedControlProps = {
    options: readonly NativeSegmentedControlOption[];
    selectedKey: string;
    onSelect: (key: string) => void;
    accessibilityLabel: string;
};

/** The height every platform's control takes, so the rows above and below do not move. */
export const NATIVE_SEGMENTED_CONTROL_HEIGHT = 32;
