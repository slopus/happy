import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

type OverlayPortalDispatch = Readonly<{
    setPortalNode: (id: string, node: React.ReactNode) => void;
    removePortalNode: (id: string) => void;
}>;

const OverlayPortalDispatchContext = React.createContext<OverlayPortalDispatch | null>(null);
const OverlayPortalNodesContext = React.createContext<ReadonlyMap<string, React.ReactNode> | null>(null);

export function OverlayPortalProvider(props: { children: React.ReactNode }) {
    const [nodes, setNodes] = React.useState<Map<string, React.ReactNode>>(() => new Map());

    const setPortalNode = React.useCallback((id: string, node: React.ReactNode) => {
        setNodes((prev) => {
            const next = new Map(prev);
            next.set(id, node);
            return next;
        });
    }, []);

    const removePortalNode = React.useCallback((id: string) => {
        setNodes((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Map(prev);
            next.delete(id);
            return next;
        });
    }, []);

    const dispatch = React.useMemo<OverlayPortalDispatch>(() => {
        return { setPortalNode, removePortalNode };
    }, [removePortalNode, setPortalNode]);

    return (
        <OverlayPortalDispatchContext.Provider value={dispatch}>
            <OverlayPortalNodesContext.Provider value={nodes}>
                {props.children}
            </OverlayPortalNodesContext.Provider>
        </OverlayPortalDispatchContext.Provider>
    );
}

export function useOverlayPortal() {
    return React.useContext(OverlayPortalDispatchContext);
}

function useOverlayPortalNodes() {
    return React.useContext(OverlayPortalNodesContext);
}

export function OverlayPortalHost(props: { pointerEvents?: 'box-none' | 'none' | 'auto' | 'box-only' } = {}) {
    const nodes = useOverlayPortalNodes();
    if (!nodes || nodes.size === 0) return null;

    return (
        <View
            pointerEvents={props.pointerEvents ?? 'box-none'}
            style={[StyleSheet.absoluteFill, { zIndex: 999999, elevation: 999999 }]}
        >
            {Array.from(nodes.entries()).map(([id, node]) => (
                <React.Fragment key={id}>
                    {node}
                </React.Fragment>
            ))}
        </View>
    );
}
