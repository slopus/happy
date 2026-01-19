import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, StyleProp, Text, TextStyle, View, ViewStyle } from 'react-native';
import { iOSUIKit } from 'react-native-typography';
import { Typography } from '@/constants/Typography';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

export type RoundButtonSize = 'large' | 'normal' | 'small';
const sizes: { [key in RoundButtonSize]: { height: number, fontSize: number, hitSlop: number, pad: number } } = {
    large: { height: 48, fontSize: 21, hitSlop: 0, pad: Platform.OS == 'ios' ? 0 : -1 },
    normal: { height: 32, fontSize: 16, hitSlop: 8, pad: Platform.OS == 'ios' ? 1 : -2 },
    small: { height: 24, fontSize: 14, hitSlop: 12, pad: Platform.OS == 'ios' ? -1 : -1 }
}

export type RoundButtonDisplay = 'default' | 'inverted';

const stylesheet = StyleSheet.create((theme) => ({
    loadingContainer: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        alignItems: 'center',
        justifyContent: 'center',
    },
    contentContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 64,
        paddingHorizontal: 16,
        borderRadius: 9999,
    },
    text: {
        ...Typography.default('semiBold'),
        fontWeight: '600',
        includeFontPadding: false,
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
    const displays: { [key in RoundButtonDisplay]: {
        textColor: string,
        backgroundColor: string,
        borderColor: string,
    } } = {
        default: {
            backgroundColor: theme.colors.button.primary.background,
            borderColor: 'transparent',
            textColor: theme.colors.button.primary.tint
        },
        inverted: {
            backgroundColor: 'transparent',
            borderColor: 'transparent',
            textColor: theme.colors.text,
        }
    }

    const size = sizes[props.size || 'large'];
    const display = displays[props.display || 'default'];

    return (
        <Pressable
            disabled={doLoading || props.disabled}
            hitSlop={size.hitSlop}
            style={(p) => ([
                {
                    borderWidth: 1,
                    borderRadius: size.height / 2,
                    backgroundColor: display.backgroundColor,
                    borderColor: display.borderColor,
                    opacity: props.disabled ? 0.5 : 1,
                    overflow: 'hidden',
                },
                {
                    opacity: p.pressed ? 0.9 : 1
                },
                props.style])}
            onPress={doAction}
        >
            <View 
                style={[
                    styles.contentContainer,
                    { height: size.height - 2 }
                ]}
            >
                {doLoading && (
                    <View style={styles.loadingContainer}>
                        <ActivityIndicator color={display.textColor} size='small' />
                    </View>
                )}
                <Text 
                    style={[
                        iOSUIKit.title3, 
                        styles.text,
                        { 
                            marginTop: size.pad, 
                            opacity: doLoading ? 0 : 1, 
                            color: display.textColor, 
                            fontSize: size.fontSize, 
                        }, 
                        props.textStyle
                    ]} 
                    numberOfLines={1}
                >
                    {props.title}
                </Text>
            </View>
        </Pressable>
    )
});