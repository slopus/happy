import * as React from 'react';
import { Platform, type StyleProp, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        borderRadius: 12,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface,
        borderWidth: Platform.OS === 'web' ? 0 : 0.5,
        borderColor: theme.colors.modal.border,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 2 },
        shadowRadius: 3.84,
        shadowOpacity: theme.colors.shadow.opacity,
        elevation: 5,
    },
}));

export type FloatingOverlayEdgeFades =
    | boolean
    | Readonly<{
            top?: boolean;
            bottom?: boolean;
            left?: boolean;
            right?: boolean;
            /** Gradient size in px (default 18). */
            size?: number;
        }>;

export type FloatingOverlayArrow =
    | boolean
    | Readonly<{
            /**
             * The popover placement relative to its anchor. The arrow is rendered on the opposite
             * edge (closest to the anchor), so `placement="bottom"` results in a top arrow.
             */
            placement: 'top' | 'bottom' | 'left' | 'right';
            /** Square size in px (default 12). */
            size?: number;
        }>;

interface FloatingOverlayProps {
    children: React.ReactNode;
    maxHeight?: number;
    showScrollIndicator?: boolean;
    keyboardShouldPersistTaps?: boolean | 'always' | 'never' | 'handled';
    edgeFades?: FloatingOverlayEdgeFades;
    containerStyle?: StyleProp<ViewStyle>;
    scrollViewStyle?: StyleProp<ViewStyle>;
    /**
     * Optional subtle chevrons (up/down/left/right) that show when more content
     * exists beyond the current scroll position. Defaults to false.
     */
    edgeIndicators?: boolean | Readonly<{ size?: number; opacity?: number }>;
    /** Optional arrow that points back to the anchor (useful for context menus). */
    arrow?: FloatingOverlayArrow;
}

export const FloatingOverlay = React.memo((props: FloatingOverlayProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { 
        children, 
        maxHeight = 240, 
        showScrollIndicator = false, 
        keyboardShouldPersistTaps = 'handled',
        edgeFades = false,
        edgeIndicators = false,
        arrow = false,
        containerStyle,
        scrollViewStyle,
    } = props;

    const fadeCfg = React.useMemo(() => {
        if (!edgeFades) return null;
        if (edgeFades === true) return { top: true, bottom: true, size: 18 } as const;
        return {
            top: edgeFades.top ?? false,
            bottom: edgeFades.bottom ?? false,
            left: edgeFades.left ?? false,
            right: edgeFades.right ?? false,
            size: typeof edgeFades.size === 'number' ? edgeFades.size : 18,
        };
    }, [edgeFades]);

    const indicatorCfg = React.useMemo(() => {
        if (!edgeIndicators) return null;
        if (edgeIndicators === true) return { size: 14, opacity: 0.35 } as const;
        return {
            size: typeof edgeIndicators.size === 'number' ? edgeIndicators.size : 14,
            opacity: typeof edgeIndicators.opacity === 'number' ? edgeIndicators.opacity : 0.35,
        };
    }, [edgeIndicators]);

    const fades = useScrollEdgeFades({
        enabledEdges: {
            top: Boolean(fadeCfg?.top) || Boolean(indicatorCfg),
            bottom: Boolean(fadeCfg?.bottom) || Boolean(indicatorCfg),
            left: Boolean(fadeCfg?.left),
            right: Boolean(fadeCfg?.right),
        },
        overflowThreshold: 1,
        edgeThreshold: 1,
    });

    const arrowCfg = React.useMemo(() => {
        if (!arrow) return null;
        if (arrow === true) return { placement: 'bottom' as const, size: 12 } as const;
        return {
            placement: arrow.placement,
            size: typeof arrow.size === 'number' ? arrow.size : 12,
        };
    }, [arrow]);

    const arrowSide = React.useMemo(() => {
        const placement = arrowCfg?.placement;
        if (!placement) return null;
        switch (placement) {
            case 'top':
                return 'bottom';
            case 'bottom':
                return 'top';
            case 'left':
                return 'right';
            case 'right':
                return 'left';
        }
    }, [arrowCfg?.placement]);

    const overlay = (
        <Animated.View style={[styles.container, { maxHeight }, containerStyle]}>
            <Animated.ScrollView
                style={[{ maxHeight }, scrollViewStyle]}
                keyboardShouldPersistTaps={keyboardShouldPersistTaps}
                showsVerticalScrollIndicator={showScrollIndicator}
                scrollEventThrottle={32}
                onLayout={fadeCfg || indicatorCfg ? fades.onViewportLayout : undefined}
                onContentSizeChange={fadeCfg || indicatorCfg ? fades.onContentSizeChange : undefined}
                onScroll={fadeCfg || indicatorCfg ? fades.onScroll : undefined}
            >
                {children}
            </Animated.ScrollView>
            {fadeCfg ? (
                <ScrollEdgeFades
                    color={theme.colors.surface}
                    size={fadeCfg.size}
                    edges={fades.visibility}
                />
            ) : null}

            {indicatorCfg ? (
                <ScrollEdgeIndicators
                    edges={fades.visibility}
                    color={theme.colors.textSecondary}
                    size={indicatorCfg.size}
                    opacity={indicatorCfg.opacity}
                />
            ) : null}
        </Animated.View>
    );

    if (!arrowCfg || !arrowSide) return overlay;

    const arrowSize = arrowCfg.size;
    const protrusion = arrowSize / 2;

    const arrowStyle = (() => {
        const base = {
            position: 'absolute' as const,
            width: arrowSize,
            height: arrowSize,
            backgroundColor: theme.colors.surface,
            borderWidth: Platform.OS === 'web' ? 0 : 0.5,
            borderColor: theme.colors.modal.border,
            ...(Platform.OS === 'web'
                ? ({
                        // RN-web can be inconsistent with shadow props on transformed views.
                        // Use CSS box-shadow to ensure the arrow is visible, even on light backdrops.
                        boxShadow: theme.dark
                            ? '0 4px 14px rgba(0, 0, 0, 0.55)'
                            : '0 4px 14px rgba(0, 0, 0, 0.24)',
                    } as any)
                : {
                        shadowColor: theme.colors.shadow.color,
                        shadowOffset: { width: 0, height: 2 },
                        shadowRadius: 3.84,
                        shadowOpacity: theme.colors.shadow.opacity,
                        elevation: 5,
                    }),
            transform: [{ rotate: '45deg' as const }],
            pointerEvents: 'none' as const,
        };

        switch (arrowSide) {
            case 'top':
                return [base, { top: -protrusion, left: '50%', marginLeft: -protrusion }] as const;
            case 'bottom':
                return [base, { bottom: -protrusion, left: '50%', marginLeft: -protrusion }] as const;
            case 'left':
                return [base, { left: -protrusion, top: '50%', marginTop: -protrusion }] as const;
            case 'right':
                return [base, { right: -protrusion, top: '50%', marginTop: -protrusion }] as const;
        }
    })();

    return (
        <Animated.View style={{ position: 'relative' }}>
            <Animated.View testID="floating-overlay-arrow" style={arrowStyle as any} />
            {overlay}
        </Animated.View>
    );
});
