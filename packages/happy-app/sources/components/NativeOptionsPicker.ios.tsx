import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import {
    Button,
    Host,
    HStack,
    Image,
    Menu,
    Section,
    Spacer,
    Text,
} from '@expo/ui/swift-ui';
import {
    accessibilityLabel,
    buttonStyle,
    contentShape,
    disabled,
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
    // The React Native row IS the visual: it colors reliably in both themes,
    // matching the dark theme exactly on the fixed dark scrim. SwiftUI above
    // it is only an invisible full-row hit target for the native menu —
    // coloring its label proved impossible (tint ignored by the plain-style
    // Menu, foregroundStyle ignored by its Text).
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
    tintColor,
}: NativeOptionsPickerProps) {
    const { theme } = useUnistyles();
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
            {/* The host must not perform keyboard avoidance: it is pinned over a
                control React Native already positions, so SwiftUI keyboard
                avoidance would drag the trigger off it. */}
            <Host
                // Same remount-on-theme-change as NativeSettingsMenu: SwiftUI
                // hosts keep the old tint when the app theme flips at runtime.
                key={theme.dark ? 'dark' : 'light'}
                ignoreSafeArea="keyboard"
                style={styles.host}
            >
                <Menu
                    // The tint is what colors the label, so it has to follow the
                    // theme: SwiftUI draws the visible row here, and a fixed
                    // white would render it invisible in light mode.
                    // No glass capsule: the plain style leaves the system less
                    // chrome to morph when the menu opens.
                    modifiers={[tint(theme.colors.text), buttonStyle('plain')]}
                    label={(
                        // The label is a hit target ONLY: the visible row is the
                        // React Native child underneath, which colors reliably
                        // in both themes. Coloring the SwiftUI label proved a
                        // moving target — the plain-style Menu ignored tint(),
                        // and its UIKit-backed Text ignored foregroundStyle
                        // while the Image obeyed it, leaving black text next to
                        // a white icon on the dark scrim. Hidden, not removed:
                        // the row must still span the full trigger area.
                        <HStack
                            spacing={12}
                            modifiers={[
                                frame({ maxWidth: 10000, maxHeight: 10000, minHeight: 42 }),
                                contentShape(shapes.rectangle()),
                                accessibilityLabel(`${title}: ${triggerLabel}`),
                                opacity(0.01),
                            ]}
                        >
                            {triggerSystemImage ? (
                                <Image systemName={systemImage(triggerSystemImage)} size={18} />
                            ) : null}
                            <Text>{triggerLabel}</Text>
                            <Spacer minLength={8} />
                        </HStack>
                    )}
                >
                    {/* A native menu's section header becomes a UIMenu title,
                        which is a plain string, so an SF Symbol placed there is
                        dropped. A disabled item is the one menu row that renders
                        an icon, so the heading is built from one. */}
                    <Section>
                        <Button
                            label={title}
                            systemImage={triggerSystemImage ? systemImage(triggerSystemImage) : undefined}
                            modifiers={[disabled(true)]}
                            onPress={() => {}}
                        />
                    </Section>
                    <Section>
                        {options.map((option) => (
                            <Button
                                key={option.key}
                                label={option.label}
                                systemImage={option.key === selectedKey ? systemImage('checkmark') : undefined}
                                onPress={() => onSelect(option.key)}
                            />
                        ))}
                    </Section>
                </Menu>
            </Host>
        </View>
    );
}
