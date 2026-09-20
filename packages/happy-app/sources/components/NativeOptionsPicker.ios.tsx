import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import {
    Button,
    Host,
    HStack,
    Menu,
    Section,
    Spacer,
    Text,
    Toggle,
} from '@expo/ui/swift-ui';
import {
    accessibilityLabel,
    buttonStyle,
    contentShape,
    disabled,
    frame,
    lineLimit,
    shapes,
    tint,
} from '@expo/ui/swift-ui/modifiers';
import type { NativeOptionsPickerProps } from './NativeOptionsPicker';

const styles = StyleSheet.create({
    container: {
        position: 'relative',
        width: '100%',
        flexGrow: 1,
        minWidth: 0,
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
    sections,
    selectedKey,
    onSelect,
    onMenuOpen,
    children,
    tintColor,
}: NativeOptionsPickerProps) {
    const { theme } = useUnistyles();
    // The check is the system's own selection state, which each Toggle keeps on
    // the native side. Tapping a row flips that state there whether or not the
    // choice changes anything in React (re-choosing the current row does not),
    // so the rows are remounted after every tap to read the selection back
    // from props instead of trusting what the last tap left behind.
    const [generation, setGeneration] = React.useState(0);
    const select = (key: string) => {
        setGeneration((current) => current + 1);
        onSelect(key);
    };
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
                        // The value alone is the label. The row's icon is a React
                        // Native view beside this host, so it stays put while the
                        // system morphs the value into the menu platter.
                        <HStack
                            spacing={0}
                            modifiers={[
                                frame({ maxWidth: 10000, maxHeight: 10000, minHeight: 42 }),
                                contentShape(shapes.rectangle()),
                                accessibilityLabel(`${title}: ${triggerLabel}`),
                            ]}
                        >
                            {/* Half a row is narrow: a long project name has to
                                truncate here rather than wrap onto a second
                                line or be clipped mid-glyph by the RN frame. */}
                            <Text modifiers={[lineLimit(1)]}>{triggerLabel}</Text>
                            <Spacer minLength={8} />
                        </HStack>
                    )}
                >
                    {sections.map((section) => (
                        <Section
                            key={section.key}
                            header={section.title ? <Text>{section.title}</Text> : undefined}
                        >
                            {section.options.map((option) => option.action ? (
                                <Button
                                    key={option.key}
                                    label={option.label}
                                    modifiers={[disabled(option.disabled === true)]}
                                    onPress={() => onSelect(option.key)}
                                />
                            ) : (
                                // A Toggle in a menu is the system's checkable
                                // row: its check is the small leading mark that
                                // every row in the menu, header included,
                                // shares one text edge with. A checkmark image
                                // was the wide icon column instead, and only
                                // the section holding it moved.
                                <Toggle
                                    key={`${option.key}:${generation}`}
                                    label={option.label}
                                    isOn={option.key === selectedKey}
                                    modifiers={[disabled(option.disabled === true)]}
                                    onIsOnChange={() => select(option.key)}
                                />
                            ))}
                        </Section>
                    ))}
                </Menu>
            </Host>
        </View>
    );
}
