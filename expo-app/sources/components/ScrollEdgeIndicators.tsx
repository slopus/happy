import * as React from 'react';
import { View, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export type ScrollEdgeIndicatorVisibility = Readonly<{
    top?: boolean;
    bottom?: boolean;
    left?: boolean;
    right?: boolean;
}>;

export function ScrollEdgeIndicators(props: {
    edges: ScrollEdgeIndicatorVisibility;
    color: string;
    size?: number;
    opacity?: number;
    topStyle?: ViewStyle;
    bottomStyle?: ViewStyle;
    leftStyle?: ViewStyle;
    rightStyle?: ViewStyle;
}) {
    const edges = props.edges;
    const size = typeof props.size === 'number' ? props.size : 14;
    const opacity = typeof props.opacity === 'number' ? props.opacity : 0.35;

    if (!edges.top && !edges.bottom && !edges.left && !edges.right) return null;

    return (
        <>
            {edges.top ? (
                <View
                    style={[
                        {
                            position: 'absolute',
                            top: 6,
                            left: 0,
                            right: 0,
                            alignItems: 'center',
                            zIndex: 11,
                            opacity,
                            pointerEvents: 'none',
                        },
                        props.topStyle,
                    ]}
                >
                    <Ionicons name="chevron-up" size={size} color={props.color} />
                </View>
            ) : null}

            {edges.bottom ? (
                <View
                    style={[
                        {
                            position: 'absolute',
                            bottom: 6,
                            left: 0,
                            right: 0,
                            alignItems: 'center',
                            zIndex: 11,
                            opacity,
                            pointerEvents: 'none',
                        },
                        props.bottomStyle,
                    ]}
                >
                    <Ionicons name="chevron-down" size={size} color={props.color} />
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
                            justifyContent: 'center',
                            zIndex: 11,
                            opacity,
                            pointerEvents: 'none',
                        },
                        props.leftStyle,
                    ]}
                >
                    <View style={{ width: '100%', alignItems: 'center' }}>
                        <Ionicons name="chevron-back" size={size} color={props.color} />
                    </View>
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
                            justifyContent: 'center',
                            zIndex: 11,
                            opacity,
                            pointerEvents: 'none',
                        },
                        props.rightStyle,
                    ]}
                >
                    <View style={{ width: '100%', alignItems: 'center' }}>
                        <Ionicons name="chevron-forward" size={size} color={props.color} />
                    </View>
                </View>
            ) : null}
        </>
    );
}

