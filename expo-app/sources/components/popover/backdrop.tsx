import * as React from 'react';
import { Platform, Pressable, View, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { PopoverBackdropEffect, PopoverPortalOptions, PopoverWindowRect } from './_types';

export function PopoverBackdrop(props: Readonly<{
    backdrop: boolean | Readonly<{ enabled?: boolean }> | undefined;
    backdropBlocksOutsidePointerEvents: boolean;
    backdropEffect: PopoverBackdropEffect;
    backdropBlurOnWeb: Readonly<{ px?: number; tintColor?: string }> | undefined;
    backdropSpotlight: boolean | Readonly<{ padding?: number }>;
    backdropAnchorOverlay: React.ReactNode | ((params: Readonly<{ rect: PopoverWindowRect }>) => React.ReactNode) | undefined;
    backdropStyle: any;
    closeOnBackdropPan: boolean;
    onRequestClose: (() => void) | undefined;

    shouldPortal: boolean;
    shouldPortalWeb: boolean;
    portal: PopoverPortalOptions | undefined;
    portalOpacity: number;
    portalPositionOnWeb: ViewStyle['position'];
    fixedPositionOnWeb: ViewStyle['position'];
    portalZ: number;

    anchorRect: PopoverWindowRect | null;
    windowWidth: number;
    windowHeight: number;
    webPortalOffsetX: number;
    webPortalOffsetY: number;
}>) {
    const backdropEnabled =
        typeof props.backdrop === 'boolean'
            ? props.backdrop
            : ((props.backdrop as any)?.enabled ?? true);

    if (!backdropEnabled) return null;

    return (
        <>
            {props.backdropEffect !== 'none' ? (
                <PopoverBackdropEffectLayer
                    backdropEffect={props.backdropEffect}
                    backdropBlurOnWeb={props.backdropBlurOnWeb}
                    backdropSpotlight={props.backdropSpotlight}
                    shouldPortal={props.shouldPortal}
                    shouldPortalWeb={props.shouldPortalWeb}
                    portalOpacity={props.portalOpacity}
                    portalPositionOnWeb={props.portalPositionOnWeb}
                    fixedPositionOnWeb={props.fixedPositionOnWeb}
                    portalZ={props.portalZ}
                    anchorRect={props.anchorRect}
                    windowWidth={props.windowWidth}
                    windowHeight={props.windowHeight}
                    webPortalOffsetX={props.webPortalOffsetX}
                    webPortalOffsetY={props.webPortalOffsetY}
                />
            ) : null}

            {props.backdropBlocksOutsidePointerEvents ? (
                <Pressable
                    onPress={props.onRequestClose}
                    pointerEvents={props.portalOpacity === 0 ? 'none' : 'auto'}
                    onMoveShouldSetResponderCapture={() => {
                        if (!props.closeOnBackdropPan || !props.onRequestClose) return false;
                        props.onRequestClose();
                        return false;
                    }}
                    style={[
                        {
                            position: props.fixedPositionOnWeb,
                            top: Platform.OS === 'web' ? 0 : (props.shouldPortal ? 0 : -1000),
                            left: Platform.OS === 'web' ? 0 : (props.shouldPortal ? 0 : -1000),
                            right: Platform.OS === 'web' ? 0 : (props.shouldPortal ? 0 : -1000),
                            bottom: Platform.OS === 'web' ? 0 : (props.shouldPortal ? 0 : -1000),
                            opacity: props.portalOpacity,
                            zIndex: props.shouldPortal ? props.portalZ : 999,
                        },
                        props.backdropStyle,
                    ]}
                />
            ) : null}

            {props.shouldPortal && props.backdropEffect !== 'none' && props.backdropAnchorOverlay && props.anchorRect ? (
                <View
                    testID="popover-anchor-overlay"
                    pointerEvents="none"
                    style={[
                        {
                            position: props.shouldPortalWeb ? props.portalPositionOnWeb : 'absolute',
                            left: (() => {
                                const offsetX = props.portalPositionOnWeb === 'absolute' ? props.webPortalOffsetX : 0;
                                return Math.max(0, Math.floor(props.anchorRect!.x - offsetX));
                            })(),
                            top: (() => {
                                const offsetY = props.portalPositionOnWeb === 'absolute' ? props.webPortalOffsetY : 0;
                                return Math.max(0, Math.floor(props.anchorRect!.y - offsetY));
                            })(),
                            width: (() => {
                                const offsetX = props.portalPositionOnWeb === 'absolute' ? props.webPortalOffsetX : 0;
                                const left = Math.max(0, Math.floor(props.anchorRect!.x - offsetX));
                                return Math.max(0, Math.min(props.windowWidth - left, Math.ceil(props.anchorRect!.width)));
                            })(),
                            height: (() => {
                                const offsetY = props.portalPositionOnWeb === 'absolute' ? props.webPortalOffsetY : 0;
                                const top = Math.max(0, Math.floor(props.anchorRect!.y - offsetY));
                                return Math.max(0, Math.min(props.windowHeight - top, Math.ceil(props.anchorRect!.height)));
                            })(),
                            opacity: props.portalOpacity,
                            zIndex: props.portalZ + 1,
                        } as const,
                    ]}
                >
                    {typeof props.backdropAnchorOverlay === 'function'
                        ? props.backdropAnchorOverlay({ rect: props.anchorRect })
                        : props.backdropAnchorOverlay}
                </View>
            ) : null}
        </>
    );
}

function PopoverBackdropEffectLayer(props: Readonly<{
    backdropEffect: PopoverBackdropEffect;
    backdropBlurOnWeb: Readonly<{ px?: number; tintColor?: string }> | undefined;
    backdropSpotlight: boolean | Readonly<{ padding?: number }>;
    shouldPortal: boolean;
    shouldPortalWeb: boolean;
    portalOpacity: number;
    portalPositionOnWeb: ViewStyle['position'];
    fixedPositionOnWeb: ViewStyle['position'];
    portalZ: number;
    anchorRect: PopoverWindowRect | null;
    windowWidth: number;
    windowHeight: number;
    webPortalOffsetX: number;
    webPortalOffsetY: number;
}>) {
    const position =
        Platform.OS === 'web' && props.shouldPortalWeb
            ? props.portalPositionOnWeb
            : props.fixedPositionOnWeb;
    const zIndex = props.shouldPortal ? props.portalZ : 998;
    const edge = Platform.OS === 'web' ? 0 : (props.shouldPortal ? 0 : -1000);

    const fullScreenStyle = [
        StyleSheet.absoluteFill,
        {
            position,
            top: position === 'absolute' ? 0 : edge,
            left: position === 'absolute' ? 0 : edge,
            right: position === 'absolute' ? 0 : edge,
            bottom: position === 'absolute' ? 0 : edge,
            opacity: props.portalOpacity,
            zIndex,
        } as const,
    ];

    const spotlightPadding = (() => {
        if (!props.backdropSpotlight) return 0;
        if (props.backdropSpotlight === true) return 8;
        const candidate = props.backdropSpotlight.padding;
        return typeof candidate === 'number' ? candidate : 8;
    })();

    const spotlightStyles = (() => {
        if (!props.shouldPortal) return null;
        if (!props.anchorRect) return null;
        if (!props.backdropSpotlight) return null;

        const offsetX = position === 'absolute' ? props.webPortalOffsetX : 0;
        const offsetY = position === 'absolute' ? props.webPortalOffsetY : 0;

        const left = Math.max(0, Math.floor(props.anchorRect.x - spotlightPadding - offsetX));
        const top = Math.max(0, Math.floor(props.anchorRect.y - spotlightPadding - offsetY));
        const right = Math.min(
            props.windowWidth,
            Math.ceil(props.anchorRect.x + props.anchorRect.width + spotlightPadding - offsetX),
        );
        const bottom = Math.min(
            props.windowHeight,
            Math.ceil(props.anchorRect.y + props.anchorRect.height + spotlightPadding - offsetY),
        );

        const holeHeight = Math.max(0, bottom - top);

        const base: ViewStyle = {
            position,
            opacity: props.portalOpacity,
            zIndex,
        };

        return [
            // top
            [{ ...base, top: 0, left: 0, right: 0, height: top }],
            // bottom
            [{ ...base, top: bottom, left: 0, right: 0, bottom: 0 }],
            // left
            [{ ...base, top, left: 0, width: left, height: holeHeight }],
            // right
            [{ ...base, top, left: right, right: 0, height: holeHeight }],
        ] as const;
    })();

    const effectStyles = spotlightStyles ?? [fullScreenStyle];

    if (props.backdropEffect === 'blur') {
        const webBlurPx = typeof props.backdropBlurOnWeb?.px === 'number' ? props.backdropBlurOnWeb.px : 12;
        const webBlurTint = props.backdropBlurOnWeb?.tintColor ?? 'rgba(0,0,0,0.10)';
        if (Platform.OS !== 'web') {
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const { BlurView } = require('expo-blur');
                if (BlurView) {
                    return (
                        <>
                            {effectStyles.map((style, index) => (
                                // eslint-disable-next-line react/no-array-index-key
                                <BlurView
                                    key={index}
                                    testID="popover-backdrop-effect"
                                    intensity={Platform.OS === 'ios' ? 12 : 3}
                                    tint="default"
                                    pointerEvents="none"
                                    style={style}
                                />
                            ))}
                        </>
                    );
                }
            } catch {
                // fall through to dim fallback
            }
        }

        return (
            <>
                {effectStyles.map((style, index) => (
                    <View
                        // eslint-disable-next-line react/no-array-index-key
                        key={index}
                        testID="popover-backdrop-effect"
                        pointerEvents="none"
                        style={[
                            style,
                            Platform.OS === 'web'
                                ? ({ backdropFilter: `blur(${webBlurPx}px)`, backgroundColor: webBlurTint } as any)
                                : ({ backgroundColor: 'rgba(0,0,0,0.08)' } as any),
                        ]}
                    />
                ))}
            </>
        );
    }

    return (
        <>
            {effectStyles.map((style, index) => (
                <View
                    // eslint-disable-next-line react/no-array-index-key
                    key={index}
                    testID="popover-backdrop-effect"
                    pointerEvents="none"
                    style={[
                        style,
                        { backgroundColor: 'rgba(0,0,0,0.08)' },
                    ]}
                />
            ))}
        </>
    );
}

