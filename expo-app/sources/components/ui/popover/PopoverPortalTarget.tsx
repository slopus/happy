import * as React from 'react';

export type PopoverPortalTargetState = Readonly<{
    /**
     * A native view that acts as the coordinate root for portaled popovers.
     * When present, popovers can measure anchors relative to this view via `measureLayout`
     * and position themselves in the same coordinate space they render into.
     */
    rootRef: React.RefObject<any>;
    /** Size of the coordinate root. */
    layout: Readonly<{ width: number; height: number }>;
}>;

const PopoverPortalTargetContext = React.createContext<PopoverPortalTargetState | null>(null);

export function PopoverPortalTargetContextProvider(props: { value: PopoverPortalTargetState; children: React.ReactNode }) {
    return (
        <PopoverPortalTargetContext.Provider value={props.value}>
            {props.children}
        </PopoverPortalTargetContext.Provider>
    );
}

export function usePopoverPortalTarget() {
    return React.useContext(PopoverPortalTargetContext);
}
