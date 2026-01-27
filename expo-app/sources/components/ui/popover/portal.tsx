import * as React from 'react';
import { Platform } from 'react-native';

import { requireReactDOM } from '@/utils/web/reactDomCjs';

type OverlayPortalDispatch = Readonly<{
    setPortalNode: (id: string, node: React.ReactNode) => void;
    removePortalNode: (id: string) => void;
}>;

export function useNativeOverlayPortalNode(params: Readonly<{
    overlayPortal: OverlayPortalDispatch | null;
    portalId: string;
    enabled: boolean;
    content: React.ReactNode | null;
}>) {
    const { overlayPortal, portalId, enabled, content } = params;

    React.useLayoutEffect(() => {
        if (!overlayPortal) return;
        if (!enabled || !content) {
            overlayPortal.removePortalNode(portalId);
            return;
        }
        overlayPortal.setPortalNode(portalId, content);
        return () => {
            overlayPortal.removePortalNode(portalId);
        };
    }, [content, enabled, overlayPortal, portalId]);
}

export function tryRenderWebPortal(params: Readonly<{
    shouldPortalWeb: boolean;
    portalTargetOnWeb: 'body' | 'boundary' | 'modal';
    modalPortalTarget: HTMLElement | null;
    getBoundaryDomElement: () => HTMLElement | null;
    content: React.ReactNode;
}>): React.ReactNode | null {
    if (!params.shouldPortalWeb) return null;
    if (Platform.OS !== 'web') return null;

    try {
        const ReactDOM = requireReactDOM();
        const boundaryEl = params.getBoundaryDomElement();
        const targetRequested =
            params.portalTargetOnWeb === 'modal'
                ? params.modalPortalTarget
                : params.portalTargetOnWeb === 'boundary'
                    ? boundaryEl
                    : (typeof document !== 'undefined' ? document.body : null);

        const target = targetRequested ?? (typeof document !== 'undefined' ? document.body : null);
        if (target && ReactDOM?.createPortal) {
            return ReactDOM.createPortal(params.content, target);
        }
    } catch {
        // fall back to inline render
    }

    return null;
}

