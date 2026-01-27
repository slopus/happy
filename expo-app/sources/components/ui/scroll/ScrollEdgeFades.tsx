import * as React from 'react';
import { View, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Color from 'color';

export type ScrollEdgeFadeVisibility = Readonly<{
    top?: boolean;
    bottom?: boolean;
    left?: boolean;
    right?: boolean;
}>;

export function ScrollEdgeFades(props: {
    color: string;
    size?: number;
    edges: ScrollEdgeFadeVisibility;
    topStyle?: ViewStyle;
    bottomStyle?: ViewStyle;
    leftStyle?: ViewStyle;
    rightStyle?: ViewStyle;
}) {
    const size = typeof props.size === 'number' ? props.size : 18;
    const edges = props.edges;

    const transparent = React.useMemo(() => {
        try {
            return Color(props.color).alpha(0).rgb().string();
        } catch {
            return 'transparent';
        }
    }, [props.color]);

    if (!edges.top && !edges.bottom && !edges.left && !edges.right) return null;

    return (
        <>
            {edges.top ? (
                <View
                    style={[
                        {
                            position: 'absolute',
                            left: 0,
                            right: 0,
                            top: 0,
                            height: size,
                            zIndex: 10,
                            pointerEvents: 'none',
                        },
                        props.topStyle,
                    ]}
                >
                    <LinearGradient
                        colors={[props.color, transparent]}
                        start={{ x: 0.5, y: 0 }}
                        end={{ x: 0.5, y: 1 }}
                        style={{ height: '100%', width: '100%', pointerEvents: 'none' }}
                    />
                </View>
            ) : null}

            {edges.bottom ? (
                <View
                    style={[
                        {
                            position: 'absolute',
                            left: 0,
                            right: 0,
                            bottom: 0,
                            height: size,
                            zIndex: 10,
                            pointerEvents: 'none',
                        },
                        props.bottomStyle,
                    ]}
                >
                    <LinearGradient
                        colors={[transparent, props.color]}
                        start={{ x: 0.5, y: 0 }}
                        end={{ x: 0.5, y: 1 }}
                        style={{ height: '100%', width: '100%', pointerEvents: 'none' }}
                    />
                </View>
            ) : null}

            {edges.left ? (
                <View
                    style={[
                        {
                            position: 'absolute',
                            left: 0,
                            top: 0,
                            bottom: 0,
                            width: size,
                            zIndex: 10,
                            pointerEvents: 'none',
                        },
                        props.leftStyle,
                    ]}
                >
                    <LinearGradient
                        colors={[props.color, transparent]}
                        start={{ x: 0, y: 0.5 }}
                        end={{ x: 1, y: 0.5 }}
                        style={{ height: '100%', width: '100%', pointerEvents: 'none' }}
                    />
                </View>
            ) : null}

            {edges.right ? (
                <View
                    style={[
                        {
                            position: 'absolute',
                            right: 0,
                            top: 0,
                            bottom: 0,
                            width: size,
                            zIndex: 10,
                            pointerEvents: 'none',
                        },
                        props.rightStyle,
                    ]}
                >
                    <LinearGradient
                        colors={[transparent, props.color]}
                        start={{ x: 0, y: 0.5 }}
                        end={{ x: 1, y: 0.5 }}
                        style={{ height: '100%', width: '100%', pointerEvents: 'none' }}
                    />
                </View>
            ) : null}
        </>
    );
}

