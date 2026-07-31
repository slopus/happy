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
    foregroundColor,
    shapes,
    tint,
} from '@expo/ui/swift-ui/modifiers';
import type { NativeOptionsPickerProps } from './NativeOptionsPicker';
import { useDeferredNativeMenuAction } from './nativeMenuInteraction';

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
    const deferMenuAction = useDeferredNativeMenuAction();

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
            <Host style={styles.host}>
                <Menu
                    modifiers={[tint('#FFFFFF')]}
                    label={(
                        <HStack
                            modifiers={[
                                frame({ maxWidth: 10000, maxHeight: 10000, minHeight: 42 }),
                                contentShape(shapes.rectangle()),
                                accessibilityLabel(`${title}: ${triggerLabel}`),
                                foregroundColor('clear'),
                            ]}
                        >
                            {!!triggerSystemImage && <Image systemName={systemImage(triggerSystemImage)} />}
                            <Text>{`${title}: ${triggerLabel}`}</Text>
                            <Spacer minLength={8} />
                        </HStack>
                    )}
                >
                    {options.map((option) => (
                        <Button
                            key={option.key}
                            label={option.label}
                            systemImage={option.key === selectedKey ? systemImage('checkmark') : undefined}
                            onPress={() => deferMenuAction(() => onSelect(option.key))}
                        />
                    ))}
                </Menu>
            </Host>
        </View>
    );
}
