import * as React from 'react';
import { type GestureResponderEvent, Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { type DesktopPanelSide } from '@/utils/desktopNavigationLayout';
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
        resizingSide,
    } = useDesktopWorkspaceLayout();

    const readPointerX = React.useCallback((event: GestureResponderEvent) => {
        return event.nativeEvent.pageX;
    }, []);

    return (
        <View
            accessibilityLabel={accessibilityLabel}
            accessibilityRole="adjustable"
            onMoveShouldSetResponder={() => true}
            onResponderGrant={(event) => beginPanelResize(side, readPointerX(event))}
            onResponderMove={(event) => continuePanelResize(readPointerX(event))}
            onResponderRelease={endPanelResize}
            onResponderTerminate={endPanelResize}
            onStartShouldSetResponder={() => true}
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
