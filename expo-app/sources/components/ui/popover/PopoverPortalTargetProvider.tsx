import * as React from 'react';
import { Platform, View } from 'react-native';
import { OverlayPortalHost, OverlayPortalProvider } from './OverlayPortal';
import { PopoverPortalTargetContextProvider } from './PopoverPortalTarget';

/**
 * Creates a screen-local portal host for native popovers/dropdowns.
 *
 * Why this exists:
 * - On iOS, screens presented as `containedModal` / sheet-like presentations can live in a
 *   different native coordinate space than the app root.
 * - If popovers portal to an app-root host, anchor measurements and overlay positioning can
 *   mismatch (menus appear vertically offset).
 *
 * By scoping an `OverlayPortalProvider` + `OverlayPortalHost` to the current screen subtree,
 * popovers render in the same coordinate space as their anchors.
 */
export function PopoverPortalTargetProvider(props: { children: React.ReactNode }) {
    // Web uses ReactDOM portals; scoping a native overlay host is unnecessary.
    if (Platform.OS === 'web') return <>{props.children}</>;

    const rootRef = React.useRef<any>(null);
    const [layout, setLayout] = React.useState(() => ({ width: 0, height: 0 }));

    return (
        <PopoverPortalTargetContextProvider value={{ rootRef, layout }}>
            <OverlayPortalProvider>
                <View
                    ref={rootRef}
                    style={{ flex: 1 }}
                    pointerEvents="box-none"
                    onLayout={(e) => {
                        const next = e?.nativeEvent?.layout;
                        if (!next) return;
                        setLayout((prev) => {
                            if (prev.width === next.width && prev.height === next.height) return prev;
                            return { width: next.width, height: next.height };
                        });
                    }}
                >
                    {props.children}
                    <OverlayPortalHost />
                </View>
            </OverlayPortalProvider>
        </PopoverPortalTargetContextProvider>
    );
}
