import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Button, Host, HStack, Image, Menu, Section, Spacer, Text } from '@expo/ui/swift-ui';
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
import type { NativeSettingsMenuProps } from './NativeSettingsMenu';
import { orderNativeMenuItems } from './nativeMenuOrder';

const systemImage = (name: string) => (
    name as React.ComponentProps<typeof Button>['systemImage']
);

const sectionSystemImage = (name: string) => (
    name as React.ComponentProps<typeof Image>['systemName']
);

/** Matches the React Native chip the native trigger stands in for. */
const TRIGGER_FONT_SIZE = 14;

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
                        <HStack
                            spacing={7}
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
                                            font({ size: TRIGGER_FONT_SIZE }),
                                            lineLimit(1),
                                        ]}>
                                            {triggerLabel}
                                        </Text>
                                    ) : null}
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
                    ))).map(({ group, option }) => (
                        <Button
                            key={`${group.key}:${option.key}`}
                            label={option.label}
                            systemImage={option.key === group.selectedKey
                                ? systemImage('checkmark')
                                : option.systemImage ? systemImage(option.systemImage) : undefined}
                            modifiers={[disabled(option.disabled === true)]}
                            onPress={() => group.onSelect(option.key)}
                        />
                    )) : orderItems(groups).map((group) => (
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
                            {orderItems(group.options).map((option) => (
                                <Button
                                    key={option.key}
                                    label={option.label}
                                    systemImage={option.key === group.selectedKey
                                        ? systemImage('checkmark')
                                        : option.systemImage ? systemImage(option.systemImage) : undefined}
                                    modifiers={[disabled(option.disabled === true)]}
                                    onPress={() => group.onSelect(option.key)}
                                />
                            ))}
                        </Section>
                    ))}
                </Menu>
            </Host>
        </View>
    );
}
