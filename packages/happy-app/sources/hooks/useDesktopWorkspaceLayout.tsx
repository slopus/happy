import * as React from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { usePathname } from 'expo-router';
import { useLocalSettingMutable } from '@/sync/storage';
import { useGlobalKeyboard } from '@/hooks/useGlobalKeyboard';
import {
    type DesktopPanelSide,
    getDesktopPanelResizeWidth,
    getDesktopWorkspacePanelWidths,
    isDesktopRightPanelAvailable,
    isDesktopRightPanelRoute,
} from '@/utils/desktopNavigationLayout';
import { isRunningOnMac } from '@/utils/platform';

type ResizeSession = {
    oppositePanelVisible: boolean;
    oppositePanelWidth: number;
    side: DesktopPanelSide;
    startPointerX: number;
    startWidth: number;
    windowWidth: number;
};

type DesktopWorkspaceLayoutValue = {
    enabled: boolean;
    leftVisible: boolean;
    leftWidth: number;
    rightPanelAvailable: boolean;
    rightVisible: boolean;
    rightWidth: number;
    resizingSide: DesktopPanelSide | null;
    beginPanelResize: (side: DesktopPanelSide, pointerX: number) => void;
    continuePanelResize: (pointerX: number) => void;
    endPanelResize: () => void;
    toggleLeftSidebar: () => void;
    toggleRightSidebar: () => void;
};

const EMPTY_LAYOUT: DesktopWorkspaceLayoutValue = {
    enabled: false,
    leftVisible: false,
    leftWidth: 0,
    rightPanelAvailable: false,
    rightVisible: false,
    rightWidth: 0,
    resizingSide: null,
    beginPanelResize: () => undefined,
    continuePanelResize: () => undefined,
    endPanelResize: () => undefined,
    toggleLeftSidebar: () => undefined,
    toggleRightSidebar: () => undefined,
};

const DesktopWorkspaceLayoutContext = React.createContext<DesktopWorkspaceLayoutValue>(EMPTY_LAYOUT);

/**
 * Owns the two desktop panel widths so either divider can resize against the
 * same middle-content budget, while only committing the final width to local
 * persistence when the drag ends.
 */
export const DesktopWorkspaceLayoutProvider = React.memo(function DesktopWorkspaceLayoutProvider({
    children,
    enabled,
}: {
    children: React.ReactNode;
    enabled: boolean;
}) {
    const pathname = usePathname();
    const { width: windowWidth } = useWindowDimensions();
    const [zenMode, setZenMode] = useLocalSettingMutable('zenMode');
    const [leftCollapsed, setLeftCollapsed] = useLocalSettingMutable('desktopLeftSidebarCollapsed');
    const [rightCollapsed, setRightCollapsed] = useLocalSettingMutable('desktopRightPanelCollapsed');
    const [storedLeftWidth, setStoredLeftWidth] = useLocalSettingMutable('desktopLeftSidebarWidth');
    const [storedRightWidth, setStoredRightWidth] = useLocalSettingMutable('desktopRightPanelWidth');
    const [liveLeftWidth, setLiveLeftWidth] = React.useState(storedLeftWidth);
    const [liveRightWidth, setLiveRightWidth] = React.useState(storedRightWidth);
    const [resizingSide, setResizingSide] = React.useState<DesktopPanelSide | null>(null);
    const resizeSessionRef = React.useRef<ResizeSession | null>(null);
    const liveLeftWidthRef = React.useRef(liveLeftWidth);
    const liveRightWidthRef = React.useRef(liveRightWidth);

    React.useEffect(() => {
        liveLeftWidthRef.current = liveLeftWidth;
    }, [liveLeftWidth]);
    React.useEffect(() => {
        liveRightWidthRef.current = liveRightWidth;
    }, [liveRightWidth]);
    React.useEffect(() => {
        if (!resizeSessionRef.current) setLiveLeftWidth(storedLeftWidth);
    }, [storedLeftWidth]);
    React.useEffect(() => {
        if (!resizeSessionRef.current) setLiveRightWidth(storedRightWidth);
    }, [storedRightWidth]);

    const rightPanelAvailable = enabled
        && isDesktopRightPanelRoute(pathname)
        && isDesktopRightPanelAvailable({
            isTablet: true,
            supportsPersistentPanel: Platform.OS === 'web' || isRunningOnMac(),
            windowWidth,
        });
    const leftVisible = enabled && !zenMode && !leftCollapsed;
    const rightVisible = rightPanelAvailable && !zenMode && !rightCollapsed;
    const panelWidths = React.useMemo(() => getDesktopWorkspacePanelWidths({
        leftVisible,
        requestedLeftWidth: liveLeftWidth,
        requestedRightWidth: liveRightWidth,
        rightVisible,
        windowWidth,
    }), [leftVisible, liveLeftWidth, liveRightWidth, rightVisible, windowWidth]);

    const toggleLeftSidebar = React.useCallback(() => {
        if (!enabled) return;
        if (zenMode) {
            setZenMode(false);
            setLeftCollapsed(false);
            return;
        }
        setLeftCollapsed(!leftCollapsed);
    }, [enabled, leftCollapsed, setLeftCollapsed, setZenMode, zenMode]);
    const toggleRightSidebar = React.useCallback(() => {
        if (!rightPanelAvailable) return;
        if (zenMode) {
            setZenMode(false);
            setRightCollapsed(false);
            return;
        }
        setRightCollapsed(!rightCollapsed);
    }, [rightCollapsed, rightPanelAvailable, setRightCollapsed, setZenMode, zenMode]);

    useGlobalKeyboard(undefined, {
        onToggleLeftSidebar: enabled ? toggleLeftSidebar : undefined,
        onToggleRightSidebar: rightPanelAvailable ? toggleRightSidebar : undefined,
    });

    const beginPanelResize = React.useCallback((side: DesktopPanelSide, pointerX: number) => {
        const sideVisible = side === 'left' ? leftVisible : rightVisible;
        if (!enabled || !sideVisible) return;
        resizeSessionRef.current = {
            oppositePanelVisible: side === 'left' ? rightVisible : leftVisible,
            oppositePanelWidth: side === 'left' ? panelWidths.right : panelWidths.left,
            side,
            startPointerX: pointerX,
            startWidth: side === 'left' ? panelWidths.left : panelWidths.right,
            windowWidth,
        };
        setResizingSide(side);
    }, [enabled, leftVisible, panelWidths.left, panelWidths.right, rightVisible, windowWidth]);

    const continuePanelResize = React.useCallback((pointerX: number) => {
        const session = resizeSessionRef.current;
        if (!session) return;
        const pointerDelta = pointerX - session.startPointerX;
        const desiredWidth = session.startWidth + (session.side === 'left' ? pointerDelta : -pointerDelta);
        const nextWidth = getDesktopPanelResizeWidth({
            desiredWidth,
            oppositePanelVisible: session.oppositePanelVisible,
            oppositePanelWidth: session.oppositePanelWidth,
            side: session.side,
            windowWidth: session.windowWidth,
        });
        if (session.side === 'left') {
            liveLeftWidthRef.current = nextWidth;
            setLiveLeftWidth(nextWidth);
        } else {
            liveRightWidthRef.current = nextWidth;
            setLiveRightWidth(nextWidth);
        }
    }, []);

    const endPanelResize = React.useCallback(() => {
        const session = resizeSessionRef.current;
        if (!session) return;
        resizeSessionRef.current = null;
        setResizingSide(null);
        if (session.side === 'left') {
            setStoredLeftWidth(liveLeftWidthRef.current);
        } else {
            setStoredRightWidth(liveRightWidthRef.current);
        }
    }, [setStoredLeftWidth, setStoredRightWidth]);

    React.useEffect(() => {
        if (Platform.OS !== 'web' || !resizingSide || typeof document === 'undefined') return;
        const previousCursor = document.body.style.cursor;
        const previousUserSelect = document.body.style.userSelect;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        return () => {
            document.body.style.cursor = previousCursor;
            document.body.style.userSelect = previousUserSelect;
        };
    }, [resizingSide]);

    const value = React.useMemo<DesktopWorkspaceLayoutValue>(() => ({
        enabled,
        leftVisible,
        leftWidth: panelWidths.left,
        rightPanelAvailable,
        rightVisible,
        rightWidth: panelWidths.right,
        resizingSide,
        beginPanelResize,
        continuePanelResize,
        endPanelResize,
        toggleLeftSidebar,
        toggleRightSidebar,
    }), [
        beginPanelResize,
        continuePanelResize,
        enabled,
        endPanelResize,
        leftVisible,
        panelWidths.left,
        panelWidths.right,
        resizingSide,
        rightPanelAvailable,
        rightVisible,
        toggleLeftSidebar,
        toggleRightSidebar,
    ]);

    return (
        <DesktopWorkspaceLayoutContext.Provider value={value}>
            {children}
        </DesktopWorkspaceLayoutContext.Provider>
    );
});

export function useDesktopWorkspaceLayout(): DesktopWorkspaceLayoutValue {
    return React.useContext(DesktopWorkspaceLayoutContext);
}
