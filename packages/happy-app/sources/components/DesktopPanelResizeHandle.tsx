import * as React from 'react';
import { type GestureResponderEvent, Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    DESKTOP_LEFT_PANEL_MIN_WIDTH,
    DESKTOP_RIGHT_PANEL_MIN_WIDTH,
    type DesktopPanelSide,
} from '@/utils/desktopNavigationLayout';
import { useDesktopWorkspaceLayout } from '@/hooks/useDesktopWorkspaceLayout';

export const DesktopPanelResizeHandle = React.memo(function DesktopPanelResizeHandle({
    accessibilityLabel,
    side,
    offset = 0,
}: {
    accessibilityLabel: string;
    offset?: number;
    side: DesktopPanelSide;
}) {
    const { theme } = useUnistyles();
    const {
        beginPanelResize,
        continuePanelResize,
        endPanelResize,
        leftMaximumWidth,
        leftWidth,
        resizePanelBy,
        resizingSide,
        rightMaximumWidth,
        rightWidth,
    } = useDesktopWorkspaceLayout();
    const currentWidth = side === 'left' ? leftWidth : rightWidth;
    const minimumWidth = side === 'left' ? DESKTOP_LEFT_PANEL_MIN_WIDTH : DESKTOP_RIGHT_PANEL_MIN_WIDTH;
    const maximumWidth = side === 'left' ? leftMaximumWidth : rightMaximumWidth;

    const readPointerX = React.useCallback((event: GestureResponderEvent) => {
        return event.nativeEvent.pageX;
    }, []);
    const handleKeyDown = React.useCallback((event: any) => {
        const key = event.nativeEvent?.key ?? event.key;
        let delta: number | undefined;
        if (key === 'ArrowLeft') delta = side === 'left' ? -16 : 16;
        if (key === 'ArrowRight') delta = side === 'left' ? 16 : -16;
        if (key === 'Home') delta = minimumWidth - currentWidth;
        if (key === 'End') delta = maximumWidth - currentWidth;
        if (delta === undefined) return;
        event.preventDefault?.();
        event.stopPropagation?.();
        resizePanelBy(side, delta);
    }, [currentWidth, maximumWidth, minimumWidth, resizePanelBy, side]);

    return (
        <View
            accessibilityLabel={accessibilityLabel}
            accessibilityRole="adjustable"
            accessibilityValue={{
                min: minimumWidth,
                max: maximumWidth,
                now: currentWidth,
                text: `${currentWidth} px`,
            }}
            onMoveShouldSetResponder={() => true}
            onResponderGrant={(event) => beginPanelResize(side, readPointerX(event))}
            onResponderMove={(event) => continuePanelResize(readPointerX(event))}
            onResponderRelease={endPanelResize}
            onResponderTerminate={endPanelResize}
            onStartShouldSetResponder={() => true}
            {...(Platform.OS === 'web' ? ({
                'aria-orientation': 'vertical',
                'aria-valuemax': maximumWidth,
                'aria-valuemin': minimumWidth,
                'aria-valuenow': currentWidth,
                'aria-valuetext': `${currentWidth} px`,
                onKeyDown: handleKeyDown,
                tabIndex: 0,
            } as any) : {})}
            style={[
                styles.handle,
                { left: offset },
                Platform.OS === 'web' && ({ cursor: 'col-resize', touchAction: 'none' } as any),
            ]}
            testID={`desktop-${side}-panel-resize-handle`}
        >
            <View
                style={[
                    styles.line,
                    { backgroundColor: resizingSide === side ? theme.colors.textLink : theme.colors.divider },
                ]}
            />
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    handle: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        width: 10,
        zIndex: 1200,
        alignItems: 'center',
        justifyContent: 'center',
    },
    line: {
        width: 1,
        height: '100%',
    },
}));
