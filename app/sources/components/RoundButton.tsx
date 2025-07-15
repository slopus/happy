import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, StyleProp, Text, View, ViewStyle } from 'react-native';
import { iOSUIKit } from 'react-native-typography';

export type RoundButtonSize = 'large' | 'normal' | 'small';
const sizes: { [key in RoundButtonSize]: { height: number, fontSize: number, hitSlop: number, pad: number } } = {
    large: { height: 48, fontSize: 21, hitSlop: 0, pad: Platform.OS == 'ios' ? 0 : -1 },
    normal: { height: 32, fontSize: 16, hitSlop: 8, pad: Platform.OS == 'ios' ? 1 : -2 },
    small: { height: 24, fontSize: 14, hitSlop: 12, pad: Platform.OS == 'ios' ? -1 : -1 }
}

export type RoundButtonDisplay = 'default' | 'inverted';

export const RoundButton = React.memo((props: { size?: RoundButtonSize, display?: RoundButtonDisplay, title?: any, style?: StyleProp<ViewStyle>, disabled?: boolean, loading?: boolean, onPress?: () => void, action?: () => Promise<any> }) => {
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
            backgroundColor: '#000',
            borderColor: 'transparent',
            textColor: '#fff'
        },
        inverted: {
            backgroundColor: 'transparent',
            borderColor: 'transparent',
            textColor: '#000',
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
                    opacity: props.disabled ? 0.5 : 1
                },
                {
                    opacity: p.pressed ? 0.9 : 1
                },
                props.style])}
            onPress={doAction}
        >
            <View 
                className="items-center justify-center min-w-16 px-4 rounded-full"
                style={{ 
                    height: size.height - 2,
                    backgroundColor: display.backgroundColor,
                }}
            >
                {doLoading && (
                    <View className="absolute inset-0 items-center justify-center">
                        <ActivityIndicator color={display.textColor} size='small' />
                    </View>
                )}
                <Text 
                    className="font-semibold"
                    style={[iOSUIKit.title3, { 
                        marginTop: size.pad, 
                        opacity: doLoading ? 0 : 1, 
                        color: display.textColor, 
                        fontSize: size.fontSize, 
                        fontWeight: '600', 
                        includeFontPadding: false 
                    }]} 
                    numberOfLines={1}
                >
                    {props.title}
                </Text>
            </View>
        </Pressable>
    )
});