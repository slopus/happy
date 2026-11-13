import * as React from 'react';

type WorkspaceWidth = { width: number; measure: (width: number) => void };
const Context = React.createContext<WorkspaceWidth | null>(null);

/** The row survives Task/file-owner remounts; its measurements should too. */
export function ProjectWorkspaceWidthProvider({ children }: { children: React.ReactNode }) {
    const [width, measure] = React.useState(0);
    const value = React.useMemo(() => ({ width, measure }), [width]);
    return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useProjectWorkspaceWidth(): WorkspaceWidth {
    const shared = React.useContext(Context);
    // Keep standalone scope workspaces usable outside the project owner.
    const [width, measure] = React.useState(0);
    return shared ?? { width, measure };
}
