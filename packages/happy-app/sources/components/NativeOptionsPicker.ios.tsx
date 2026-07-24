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
    frame,
    opacity,
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
    host: {
        ...StyleSheet.absoluteFillObject,
    },
});

export function NativeOptionsPicker({
    triggerLabel,
    systemImage: triggerSystemImage,
    options,
    selectedKey,
    onSelect,
    children,
}: NativeOptionsPickerProps) {
    return (
        <View style={styles.container}>
            <View pointerEvents="none">{children}</View>
            <Host
                colorScheme="dark"
                style={styles.host}
            >
                <Menu
                    modifiers={[tint('#FFFFFF')]}
                    label={(
                        <HStack
                            modifiers={[
                                frame({ maxWidth: 10000, minHeight: 42 }),
                                opacity(0.01),
                            ]}
                        >
                            {!!triggerSystemImage && <Image systemName={systemImage(triggerSystemImage)} />}
                            <Text>{triggerLabel}</Text>
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
