import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Button, Host, HStack, Image, Menu, Section, Spacer, Text, Toggle } from '@expo/ui/swift-ui';
import {
    accessibilityLabel as accessibilityLabelModifier,
    buttonStyle,
    contentShape,
    disabled,
    font,
    frame,
    lineLimit,
    opacity,
    shapes,
    tint,
} from '@expo/ui/swift-ui/modifiers';
import type {
    NativeSettingsMenuGroup,
    NativeSettingsMenuOption,
    NativeSettingsMenuProps,
} from './NativeSettingsMenu';
import { orderNativeMenuItems } from './nativeMenuOrder';
import { isNativeMenuChoice } from './nativeMenuSelection';
import { getDefaultFont } from '@/constants/Typography';

const systemImage = (name: string) => (
    name as React.ComponentProps<typeof Button>['systemImage']
);

const sectionSystemImage = (name: string) => (
    name as React.ComponentProps<typeof Image>['systemName']
);

/**
 * Matches the React Native chip the native trigger stands in for.
 *
 * The family matters as much as the size. The hidden chip underneath is what
 * gives this host its width, and it is drawn in the app's own face; left on the
 * system font, SwiftUI measured the same word wider than the frame it was given
 * and truncated a chip that had room to spare — "Auto" came out as "A…".
 */
const TRIGGER_FONT_SIZE = 14;
const TRIGGER_FONT_FAMILY = getDefaultFont();
/** Between an icon and its label, and nowhere else — see the trigger's stacks. */
const TRIGGER_ICON_GAP = 7;

const styles = StyleSheet.create({
    container: {
        position: 'relative',
    },
    trigger: {
        minWidth: 0,
    },
    triggerHidden: {
        opacity: 0,
    },
    host: {
        ...StyleSheet.absoluteFillObject,
    },
});

export function NativeSettingsMenu({
    accessibilityLabel = 'Settings',
    groups,
    children,
    style,
    onMenuOpen,
    flat = false,
    triggerLabel,
    triggerSystemImage,
    triggerAlignment = 'center',
    anchor = 'bottom',
}: NativeSettingsMenuProps) {
    const { theme } = useUnistyles();
    const nativeTrigger = triggerLabel !== undefined || triggerSystemImage !== undefined;
    // A top-anchored menu opens downward, which iOS already lays out top-down;
    // only the upward, bottom-up case needs the pre-reversal.
    const orderItems = <T,>(items: readonly T[]): T[] => (
        anchor === 'bottom' ? orderNativeMenuItems(items, 'ios') : [...items]
    );
    // The check is the system's own selection state, which each Toggle keeps on
    // the native side. Tapping a row flips it there whether or not React's
    // selection changes (re-choosing the current row does not), so the rows
    // are remounted after every tap to read the selection back from props.
    const [generation, setGeneration] = React.useState(0);
    const renderOption = (group: NativeSettingsMenuGroup, option: NativeSettingsMenuOption) => (
        isNativeMenuChoice(group) ? (
            // A Toggle in a menu is the system's checkable row: the small
            // leading check that every row in the menu, heading included,
            // shares one text edge with. A checkmark image took the wide icon
            // column instead, and only the section holding it moved.
            <Toggle
                key={`${group.key}:${option.key}:${generation}`}
                label={option.label}
                isOn={option.key === group.selectedKey}
                modifiers={[disabled(option.disabled === true)]}
                onIsOnChange={() => {
                    setGeneration((current) => current + 1);
                    group.onSelect(option.key);
                }}
            />
        ) : (
            <Button
                key={`${group.key}:${option.key}`}
                label={option.label}
                systemImage={option.systemImage ? systemImage(option.systemImage) : undefined}
                modifiers={[disabled(option.disabled === true)]}
                onPress={() => group.onSelect(option.key)}
            />
        )
    );
    return (
        <View
            style={[styles.container, style]}
            onStartShouldSetResponderCapture={() => {
                onMenuOpen?.();
                return false;
            }}
        >
            <View
                pointerEvents="none"
                accessible={false}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={[styles.trigger, nativeTrigger && styles.triggerHidden]}
            >
                {children}
            </View>
            {/* The host must not perform keyboard avoidance: it is pinned over a
                composer chip whose position React Native already manages. Left on,
                SwiftUI shifts the menu's invisible trigger up by the keyboard
                height while the host's RN frame stays put, so the chip becomes
                untappable whenever the keyboard is open. */}
            <Host
                // SwiftUI hosts do not reliably re-resolve modifiers when the
                // app theme flips at runtime, so a chip tinted for dark mode
                // stayed white on the light composer until a cold restart.
                // Remounting the host on a theme change re-applies the tint.
                key={theme.dark ? 'dark' : 'light'}
                ignoreSafeArea="keyboard"
                style={styles.host}
            >
                <Menu
                    // The tint is what colors the label, so with a native trigger
                    // it has to follow the theme: a fixed white renders the chip
                    // invisible against the light-mode composer.
                    // No glass capsule: the plain style leaves the system less
                    // chrome to morph when the menu opens.
                    modifiers={[tint(theme.colors.text), buttonStyle('plain')]}
                    label={(
                        // With a native trigger this draws the chip itself, so the
                        // system morphs a real label instead of lensing the React
                        // Native view underneath. Without one it is a hit target
                        // only and must render nothing: the Menu's own tint
                        // overrides foregroundColor on a label's text, so any real
                        // content paints white on top of the chip and reads as a
                        // duplicate. opacity hides the whole subtree regardless.
                        // VoiceOver still announces it via accessibilityLabel.
                        // The spacers that align the label are charged the
                        // stack's spacing just like a sibling would be, so a
                        // centred trigger paid the icon gap twice over for
                        // nothing between. That came straight off the label's
                        // width and truncated it. The gap belongs to the icon
                        // and its label, so it lives on their own stack now.
                        <HStack
                            spacing={0}
                            modifiers={[
                                frame({ maxWidth: 10000, maxHeight: 10000, minHeight: 40 }),
                                contentShape(shapes.rectangle()),
                                accessibilityLabelModifier(accessibilityLabel),
                                ...(nativeTrigger ? [] : [opacity(0.01)]),
                            ]}
                        >
                            {nativeTrigger ? (
                                <>
                                    {triggerAlignment === 'leading' ? null : <Spacer minLength={0} />}
                                    <HStack spacing={TRIGGER_ICON_GAP}>
                                        {triggerSystemImage ? (
                                            <Image systemName={sectionSystemImage(triggerSystemImage)} size={20} />
                                        ) : null}
                                        {triggerLabel ? (
                                            // Without the line limit the label wraps
                                            // inside a narrow trigger and the chip
                                            // renders as two stacked lines. Letting
                                            // SwiftUI truncate is what keeps an
                                            // over-long model name from being clipped
                                            // mid-glyph by the React Native frame.
                                            <Text modifiers={[
                                                font({ family: TRIGGER_FONT_FAMILY, size: TRIGGER_FONT_SIZE }),
                                                lineLimit(1),
                                            ]}>
                                                {triggerLabel}
                                            </Text>
                                        ) : null}
                                    </HStack>
                                    {triggerAlignment === 'trailing' ? null : <Spacer minLength={0} />}
                                </>
                            ) : (
                                <Spacer minLength={8} />
                            )}
                        </HStack>
                    )}
                >
                    {flat ? orderItems(groups.flatMap((group) => (
                        group.options.map((option) => ({ group, option }))
                    ))).map(({ group, option }) => renderOption(group, option))
                        : orderItems(groups).map((group) => (
                            <Section
                                key={group.key}
                                header={(group.title ?? group.label) ? (
                                    <HStack spacing={6}>
                                        {group.systemImage ? (
                                            <Image systemName={sectionSystemImage(group.systemImage)} size={14} />
                                        ) : null}
                                        {/* The heading names what is being chosen, not
                                            the current value, which the chip already shows. */}
                                        <Text>{group.title ?? group.label}</Text>
                                    </HStack>
                                ) : undefined}
                            >
                                {orderItems(group.options).map((option) => renderOption(group, option))}
                            </Section>
                        ))}
                </Menu>
            </Host>
        </View>
    );
}
