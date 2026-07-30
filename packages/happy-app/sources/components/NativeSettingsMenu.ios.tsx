import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Host, HStack, Image, Menu, Section, Spacer, Text } from '@expo/ui/swift-ui';
import {
    accessibilityLabel as accessibilityLabelModifier,
    contentShape,
    disabled,
    frame,
    foregroundColor,
    shapes,
    tint,
} from '@expo/ui/swift-ui/modifiers';
import type { NativeSettingsMenuProps } from './NativeSettingsMenu';
import { useDeferredNativeMenuAction } from './nativeMenuInteraction';

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
    const deferMenuAction = useDeferredNativeMenuAction();

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
            <Host style={styles.host}>
                <Menu
                    modifiers={[tint('#FFFFFF')]}
                    label={(
                        <HStack modifiers={[
                            frame({ maxWidth: 10000, maxHeight: 10000, minHeight: 40 }),
                            contentShape(shapes.rectangle()),
                            accessibilityLabelModifier(accessibilityLabel),
                            foregroundColor('clear'),
                        ]}>
                            <Text>{accessibilityLabel}</Text>
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
                                onPress={() => deferMenuAction(() => group.onSelect(option.key))}
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
                                    onPress={() => deferMenuAction(() => group.onSelect(option.key))}
                                />
                            ))}
                        </Section>
                    ))}
                </Menu>
            </Host>
        </View>
    );
}
