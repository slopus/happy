import * as React from 'react';

type WorkspaceWidth = { width: number; measure: (width: number) => void; catalogWidth?: number; resizeCatalog: (width: number | undefined) => void };
const Context = React.createContext<WorkspaceWidth | null>(null);

/** The row survives Task/file-owner remounts; its measurements should too. */
export function ProjectWorkspaceWidthProvider({ children }: { children: React.ReactNode }) {
    const [width, measure] = React.useState(0);
    const [catalogWidth, resizeCatalog] = React.useState<number>();
    const value = React.useMemo(() => ({ width, measure, catalogWidth, resizeCatalog }), [width, catalogWidth]);
    return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useProjectWorkspaceWidth(): WorkspaceWidth {
    const shared = React.useContext(Context);
    // Keep standalone scope workspaces usable outside the project owner.
    const [width, measure] = React.useState(0);
    const [catalogWidth, resizeCatalog] = React.useState<number>();
    return shared ?? { width, measure, catalogWidth, resizeCatalog };
}
