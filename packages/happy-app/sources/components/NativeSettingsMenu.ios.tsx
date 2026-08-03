import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Host, HStack, Image, Menu, Section, Spacer, Text } from '@expo/ui/swift-ui';
import {
    accessibilityLabel as accessibilityLabelModifier,
    contentShape,
    disabled,
    frame,
    opacity,
    shapes,
    tint,
} from '@expo/ui/swift-ui/modifiers';
import type { NativeSettingsMenuProps } from './NativeSettingsMenu';

const systemImage = (name: string) => (
    name as React.ComponentProps<typeof Button>['systemImage']
);

const sectionSystemImage = (name: string) => (
    name as React.ComponentProps<typeof Image>['systemName']
);

const styles = StyleSheet.create({
    container: {
        position: 'relative',
    },
    trigger: {
        minWidth: 0,
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
    flat = false,
}: NativeSettingsMenuProps) {
    return (
        <View style={[styles.container, style]}>
            <View
                pointerEvents="none"
                accessible={false}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={styles.trigger}
            >
                {children}
            </View>
            {/* The host must not perform keyboard avoidance: it is pinned over a
                composer chip whose position React Native already manages. Left on,
                SwiftUI shifts the menu's invisible trigger up by the keyboard
                height while the host's RN frame stays put, so the chip becomes
                untappable whenever the keyboard is open. */}
            <Host ignoreSafeArea="keyboard" style={styles.host}>
                <Menu
                    modifiers={[tint('#FFFFFF')]}
                    label={(
                        // The label is a hit target only — the visible chip is the RN
                        // view underneath. It must render nothing: the Menu's own
                        // tint overrides foregroundColor on a label's text, so any
                        // real content here paints white on top of the chip and reads
                        // as a duplicate. opacity hides the whole subtree regardless.
                        // VoiceOver still announces it via accessibilityLabel.
                        <HStack modifiers={[
                            frame({ maxWidth: 10000, maxHeight: 10000, minHeight: 40 }),
                            contentShape(shapes.rectangle()),
                            accessibilityLabelModifier(accessibilityLabel),
                            opacity(0.01),
                        ]}>
                            <Spacer minLength={8} />
                        </HStack>
                    )}
                >
                    {flat ? groups.flatMap((group) => (
                        group.options.map((option) => (
                            <Button
                                key={`${group.key}:${option.key}`}
                                label={option.label}
                                systemImage={option.key === group.selectedKey ? systemImage('checkmark') : undefined}
                                modifiers={[disabled(option.disabled === true)]}
                                onPress={() => group.onSelect(option.key)}
                            />
                        ))
                    )) : groups.map((group) => (
                        <Section
                            key={group.key}
                            header={(
                                <HStack spacing={6}>
                                    {group.systemImage ? (
                                        <Image systemName={sectionSystemImage(group.systemImage)} size={14} />
                                    ) : null}
                                    <Text>{group.label}</Text>
                                </HStack>
                            )}
                        >
                            {group.options.map((option) => (
                                <Button
                                    key={option.key}
                                    label={option.label}
                                    systemImage={option.key === group.selectedKey ? systemImage('checkmark') : undefined}
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
