import * as React from 'react';
const PopoverBoundaryContext = React.createContext<React.RefObject<any> | null>(null);

export function PopoverBoundaryProvider(props: {
    boundaryRef: React.RefObject<any>;
    children: React.ReactNode;
}) {
    return (
        <PopoverBoundaryContext.Provider value={props.boundaryRef}>
            {props.children}
        </PopoverBoundaryContext.Provider>
    );
}

export function usePopoverBoundaryRef() {
    return React.useContext(PopoverBoundaryContext);
}
