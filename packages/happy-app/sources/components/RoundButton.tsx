import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, StyleProp, Text, TextStyle, View, ViewStyle } from 'react-native';
import { Typography } from '@/constants/Typography';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

export type RoundButtonSize = 'large' | 'normal' | 'small';
// Heights follow the platform control sizes: 44 is the default mobile hit
// target, 50 is the usual first-run call to action. Labels stay at or below
// the 17pt body size so the pill never looks cramped around its text.
const sizes: { [key in RoundButtonSize]: { height: number, fontSize: number, hitSlop: number, paddingHorizontal: number } } = {
    large: { height: 50, fontSize: 17, hitSlop: 0, paddingHorizontal: 24 },
    normal: { height: 44, fontSize: 15, hitSlop: 4, paddingHorizontal: 20 },
    small: { height: 32, fontSize: 13, hitSlop: 8, paddingHorizontal: 14 },
}

/**
 * `default` is the one filled action on a screen. `inverted` is the quiet
 * text-only action underneath it: no fill, no border, still a full-height
 * tap target. Neither uses glass; buttons sit in the content layer.
 */
export type RoundButtonDisplay = 'default' | 'inverted';

const stylesheet = StyleSheet.create((theme) => ({
    pressable: {
        alignSelf: 'stretch',
    },
    contentContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 64,
        borderRadius: 9999,
    },
    loadingContainer: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        alignItems: 'center',
        justifyContent: 'center',
    },
    text: {
        ...Typography.default('semiBold'),
        fontWeight: '600',
        includeFontPadding: false,
        textAlign: 'center',
    },
    textInverted: {
        ...Typography.default(),
        fontWeight: '500',
    },
}));

export const RoundButton = React.memo((props: { size?: RoundButtonSize, display?: RoundButtonDisplay, title?: any, style?: StyleProp<ViewStyle>, textStyle?: StyleProp<TextStyle>, disabled?: boolean, loading?: boolean, onPress?: () => void, action?: () => Promise<any> }) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [loading, setLoading] = React.useState(false);
    const doLoading = props.loading !== undefined ? props.loading : loading;
    const doAction = React.useCallback(() => {
        if (props.onPress) {
            props.onPress();
            return;
        }
        if (props.action) {
            setLoading(true);
            (async () => {
                try {
                    await props.action!();
                } finally {
                    setLoading(false);
                }
            })();
        }
    }, [props.onPress, props.action]);

    // The primary token is black in both themes, so the dark fill mirrors the
    // dock's send button: a light pill with dark text.
    const displays: { [key in RoundButtonDisplay]: {
        textColor: string,
        backgroundColor: string,
        pressedBackgroundColor: string,
    } } = {
        default: {
            backgroundColor: theme.dark ? '#F5F5F5' : theme.colors.button.primary.background,
            pressedBackgroundColor: theme.dark ? '#D9D9D9' : '#333333',
            textColor: theme.dark ? '#111111' : theme.colors.button.primary.tint,
        },
        inverted: {
            backgroundColor: 'transparent',
            pressedBackgroundColor: theme.colors.surfacePressedOverlay,
            textColor: theme.colors.textSecondary,
        },
    }

    const size = sizes[props.size || 'large'];
    const isInverted = props.display === 'inverted';
    const display = displays[props.display || 'default'];

    return (
        <Pressable
            disabled={doLoading || props.disabled}
            hitSlop={size.hitSlop}
            accessibilityRole="button"
            accessibilityState={{ disabled: !!props.disabled, busy: doLoading }}
            style={(p) => ([
                styles.pressable,
                {
                    borderRadius: size.height / 2,
                    opacity: props.disabled ? 0.5 : 1,
                    overflow: Platform.OS === 'web' ? 'hidden' : 'visible',
                },
                props.style,
            ])}
            onPress={doAction}
        >
            {(p) => (
                <View
                    style={[
                        styles.contentContainer,
                        {
                            minHeight: size.height,
                            paddingHorizontal: size.paddingHorizontal,
                            // Text actions can wrap; filled pills keep one line.
                            paddingVertical: isInverted ? 8 : 0,
                            backgroundColor: p.pressed ? display.pressedBackgroundColor : display.backgroundColor,
                        },
                    ]}
                >
                    {doLoading && (
                        <View style={styles.loadingContainer}>
                            <ActivityIndicator color={display.textColor} size='small' />
                        </View>
                    )}
                    <Text
                        style={[
                            styles.text,
                            isInverted && styles.textInverted,
                            {
                                opacity: doLoading ? 0 : 1,
                                color: display.textColor,
                                fontSize: size.fontSize,
                                lineHeight: Math.round(size.fontSize * 1.3),
                            },
                            props.textStyle,
                        ]}
                        numberOfLines={isInverted ? undefined : 1}
                    >
                        {props.title}
                    </Text>
                </View>
            )}
        </Pressable>
    )
});
