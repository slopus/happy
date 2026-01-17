import * as React from 'react';
import type { SwitchProps } from 'react-native';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

const TRACK_WIDTH = 44;
const TRACK_HEIGHT = 24;
const THUMB_SIZE = 20;
const PADDING = 2;

const stylesheet = StyleSheet.create(() => ({
    track: {
        width: TRACK_WIDTH,
        height: TRACK_HEIGHT,
        borderRadius: TRACK_HEIGHT / 2,
        padding: PADDING,
        justifyContent: 'center',
    },
    thumb: {
        width: THUMB_SIZE,
        height: THUMB_SIZE,
        borderRadius: THUMB_SIZE / 2,
    },
}));

export const Switch = ({ value, disabled, onValueChange, style, ...rest }: SwitchProps) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    const translateX = value ? TRACK_WIDTH - THUMB_SIZE - PADDING * 2 : 0;

    return (
        <Pressable
            {...rest}
            accessibilityRole="switch"
            accessibilityState={{ checked: !!value, disabled: !!disabled }}
            disabled={disabled}
            onPress={() => onValueChange?.(!value)}
            style={({ pressed }) => [
                style as any,
                { opacity: disabled ? 0.6 : pressed ? 0.85 : 1 },
            ]}
        >
            <View
                style={[
                    styles.track,
                    {
                        backgroundColor: value ? theme.colors.switch.track.active : theme.colors.switch.track.inactive,
                    },
                ]}
            >
                <View
                    style={[
                        styles.thumb,
                        {
                            backgroundColor: theme.colors.switch.thumb.active,
                            transform: [{ translateX }],
                        },
                    ]}
                />
            </View>
        </Pressable>
    );
};
