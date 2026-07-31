import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Host, HStack, Menu, Spacer } from '@expo/ui/swift-ui';
import { contentShape, frame, opacity, shapes, tint } from '@expo/ui/swift-ui/modifiers';
import type { NativeSettingsMenuProps } from './NativeSettingsMenu';

const systemImage = (name: string) => (
    name as React.ComponentProps<typeof Button>['systemImage']
);

const styles = StyleSheet.create({
    container: {
        position: 'relative',
    },
    trigger: {
        flex: 1,
        minWidth: 0,
    },
    host: {
        ...StyleSheet.absoluteFillObject,
    },
});

export function NativeSettingsMenu({ groups, children, style, flat = false }: NativeSettingsMenuProps) {
    return (
        <View style={[styles.container, style]}>
            <View pointerEvents="none" style={styles.trigger}>{children}</View>
            {/* The host must not perform keyboard avoidance: it is pinned over a
                composer chip whose position React Native already manages. Left on,
                SwiftUI shifts the menu's invisible trigger up by the keyboard
                height while the host's RN frame stays put, so the chip becomes
                untappable whenever the keyboard is open. */}
            <Host colorScheme="dark" ignoreSafeArea="keyboard" style={styles.host}>
                <Menu
                    modifiers={[tint('#FFFFFF')]}
                    label={(
                        <HStack modifiers={[
                            frame({ maxWidth: 10000, minHeight: 40 }),
                            contentShape(shapes.rectangle()),
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
                                onPress={() => group.onSelect(option.key)}
                            />
                        ))
                    )) : groups.map((group) => (
                        <Menu
                            key={group.key}
                            label={group.label}
                            systemImage={group.systemImage}
                            modifiers={[tint('#FFFFFF')]}
                        >
                            {group.options.map((option) => (
                                <Button
                                    key={option.key}
                                    label={option.label}
                                    systemImage={option.key === group.selectedKey ? systemImage('checkmark') : undefined}
                                    onPress={() => group.onSelect(option.key)}
                                />
                            ))}
                        </Menu>
                    ))}
                </Menu>
            </Host>
        </View>
    );
}
