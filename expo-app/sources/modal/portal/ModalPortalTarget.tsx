import * as React from 'react';

export type ModalPortalTarget = Element | DocumentFragment | null;

const ModalPortalTargetContext = React.createContext<ModalPortalTarget>(null);

export function ModalPortalTargetProvider(props: {
    target: ModalPortalTarget;
    children: React.ReactNode;
}) {
    return (
        <ModalPortalTargetContext.Provider value={props.target}>
            {props.children}
        </ModalPortalTargetContext.Provider>
    );
}

export function useModalPortalTarget(): ModalPortalTarget {
    return React.useContext(ModalPortalTargetContext);
}

