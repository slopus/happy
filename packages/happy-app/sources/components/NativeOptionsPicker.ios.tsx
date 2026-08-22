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
    // React Native keeps the row's layout bounds while SwiftUI draws the
    // visible trigger. iOS 26 can then morph that real native label into the
    // menu platter instead of lensing a separate RN row underneath it.
    trigger: {
        width: '100%',
        minWidth: 0,
        opacity: 0,
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
    onMenuOpen,
    children,
    tintColor,
}: NativeOptionsPickerProps) {
    const { theme } = useUnistyles();
    return (
        <View
            style={styles.container}
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
                    modifiers={[tint(tintColor ?? theme.colors.text), buttonStyle('plain')]}
                    label={(
                        // The whole row is the label, so every part of it opens
                        // the menu: the icon, the value, and the space between.
                        <HStack
                            spacing={12}
                            modifiers={[
                                frame({ maxWidth: 10000, maxHeight: 10000, minHeight: 42 }),
                                contentShape(shapes.rectangle()),
                                accessibilityLabel(`${title}: ${triggerLabel}`),
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
