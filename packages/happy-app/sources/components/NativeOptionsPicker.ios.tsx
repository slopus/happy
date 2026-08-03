import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import {
    Button,
    Host,
    HStack,
    Image,
    Menu,
    Spacer,
    Text,
} from '@expo/ui/swift-ui';
import {
    accessibilityLabel,
    contentShape,
    frame,
    opacity,
    shapes,
    tint,
} from '@expo/ui/swift-ui/modifiers';
import type { NativeOptionsPickerProps } from './NativeOptionsPicker';

const systemImage = (name: string) => (
    name as React.ComponentProps<typeof Image>['systemName']
);

const styles = StyleSheet.create({
    container: {
        position: 'relative',
        width: '100%',
    },
    trigger: {
        width: '100%',
        minWidth: 0,
    },
    host: {
        ...StyleSheet.absoluteFillObject,
    },
});

export function NativeOptionsPicker({
    title,
    triggerLabel,
    systemImage: triggerSystemImage,
    options,
    selectedKey,
    onSelect,
    children,
}: NativeOptionsPickerProps) {
    return (
        <View style={styles.container}>
            <View
                pointerEvents="none"
                accessible={false}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={styles.trigger}
            >
                {children}
            </View>
            {/* See NativeSettingsMenu.ios.tsx: the host is pinned over a control
                React Native already positions, so SwiftUI keyboard avoidance would
                drag the invisible trigger off it. */}
            <Host ignoreSafeArea="keyboard" style={styles.host}>
                <Menu
                    modifiers={[tint('#FFFFFF')]}
                    label={(
                        // Hit target only. The icon and label live in the RN view
                        // underneath; rendering them here too paints a second copy
                        // over it, because the Menu's tint beats foregroundColor.
                        <HStack
                            modifiers={[
                                frame({ maxWidth: 10000, maxHeight: 10000, minHeight: 42 }),
                                contentShape(shapes.rectangle()),
                                accessibilityLabel(`${title}: ${triggerLabel}`),
                                opacity(0.01),
                            ]}
                        >
                            <Spacer minLength={8} />
                        </HStack>
                    )}
                >
                    {options.map((option) => (
                        <Button
                            key={option.key}
                            label={option.label}
                            systemImage={option.key === selectedKey ? systemImage('checkmark') : undefined}
                            onPress={() => onSelect(option.key)}
                        />
                    ))}
                </Menu>
            </Host>
        </View>
    );
}
