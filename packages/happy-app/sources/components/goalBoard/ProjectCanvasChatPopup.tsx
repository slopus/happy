import type { ReactNode } from 'react';

export type ProjectCanvasChatPopupProps = {
    /** Compact layouts keep the conversation in its own tab. */
    compact?: boolean;
    /** Hidden workspace views keep the conversation mounted and close the popup. */
    active?: boolean;
    children: (action: ReactNode) => ReactNode;
};

export function ProjectCanvasChatPopup({ children }: ProjectCanvasChatPopupProps) {
    return <>{children(null)}</>;
}
