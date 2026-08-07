import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type {
    DesktopPresenceTransitionProps,
    DesktopTransitionDirection,
} from './DesktopPresenceTransition.types';

export type { DesktopPresenceTransitionProps, DesktopTransitionDirection } from './DesktopPresenceTransition.types';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const TRANSITION_FALLBACK_MS = 190;

type PresencePhase = 'entering' | 'active' | 'exiting' | 'settled';
type PresenceLayer = {
    direction: DesktopTransitionDirection;
    id: number;
    key: string;
    node: React.ReactNode;
    phase: PresencePhase;
};

type PresenceLayerViewProps = {
    layer: PresenceLayer;
    onOpacityTransitionEnd: (sequence: number) => void;
    sequence: number;
};

function createSettledLayer(
    children: React.ReactNode | null,
    direction: DesktopTransitionDirection,
    id: number,
    transitionKey: string,
): PresenceLayer[] {
    return children === null ? [] : [{
        direction,
        id,
        key: transitionKey,
        node: children,
        phase: 'settled',
    }];
}

function PresenceLayerView({ layer, onOpacityTransitionEnd, sequence }: PresenceLayerViewProps) {
    const removeListenerRef = React.useRef<(() => void) | null>(null);
    const exiting = layer.phase === 'exiting';

    const setElementRef = React.useCallback((instance: View | null) => {
        removeListenerRef.current?.();
        removeListenerRef.current = null;

        const element = instance as unknown as HTMLElement | null;
        if (!element || exiting) return;

        const listener = (event: TransitionEvent) => {
            if (event.target !== element || event.propertyName !== 'opacity') return;
            onOpacityTransitionEnd(sequence);
        };

        element.addEventListener('transitionend', listener);
        removeListenerRef.current = () => element.removeEventListener('transitionend', listener);
    }, [exiting, onOpacityTransitionEnd, sequence]);

    React.useEffect(() => () => {
        removeListenerRef.current?.();
        removeListenerRef.current = null;
    }, []);

    return (
        <View
            aria-hidden={exiting}
            accessibilityElementsHidden={exiting}
            {...({
                dataSet: {
                    happyMotion: 'desktop-presence-layer',
                    happyPresenceDirection: layer.direction,
                    happyPresencePhase: layer.phase,
                },
                inert: exiting ? true : undefined,
            } as any)}
            importantForAccessibility={exiting ? 'no-hide-descendants' : 'auto'}
            pointerEvents={exiting ? 'none' : 'auto'}
            ref={setElementRef}
            style={styles.layer}
            testID="presence-layer"
        >
            {layer.node}
        </View>
    );
}

export function DesktopPresenceTransition({
    children,
    direction,
    immediate = false,
    testID,
    transitionKey,
}: DesktopPresenceTransitionProps) {
    const sequenceRef = React.useRef(0);
    const [layers, setLayers] = React.useState<PresenceLayer[]>(() => children === null ? [] : [{
        direction,
        id: 0,
        key: transitionKey,
        node: children,
        phase: 'settled',
    }]);
    const frameRef = React.useRef<number | null>(null);
    const fallbackRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingSequenceRef = React.useRef<number | null>(null);
    const renderedKeyRef = React.useRef(transitionKey);
    const latestRef = React.useRef({ children, direction, transitionKey });
    const reducedMotionRef = React.useRef(
        typeof window !== 'undefined' && window.matchMedia(REDUCED_MOTION_QUERY).matches,
    );
    latestRef.current = { children, direction, transitionKey };

    const cancelPendingWork = React.useCallback(() => {
        if (frameRef.current !== null) {
            cancelAnimationFrame(frameRef.current);
            frameRef.current = null;
        }
        if (fallbackRef.current !== null) {
            clearTimeout(fallbackRef.current);
            fallbackRef.current = null;
        }
    }, []);

    const settleTransition = React.useCallback((sequence: number) => {
        if (sequenceRef.current !== sequence || pendingSequenceRef.current !== sequence) return;
        cancelPendingWork();
        pendingSequenceRef.current = null;
        setLayers((previous) => previous
            .filter((layer) => layer.phase !== 'exiting')
            .map((layer) => layer.id === sequence && (layer.phase === 'entering' || layer.phase === 'active')
                ? { ...layer, phase: 'settled' }
                : layer));
    }, [cancelPendingWork]);

    React.useLayoutEffect(() => {
        if (immediate || reducedMotionRef.current) {
            cancelPendingWork();
            pendingSequenceRef.current = null;
            const preserveActiveLayer = renderedKeyRef.current === transitionKey;
            const nextId = preserveActiveLayer
                ? sequenceRef.current
                : ++sequenceRef.current;
            renderedKeyRef.current = transitionKey;
            setLayers((previous) => {
                if (children === null) return [];
                const active = preserveActiveLayer
                    ? previous.find((layer) => (
                        layer.phase !== 'exiting' && layer.key === transitionKey
                    ))
                    : undefined;
                if (active) {
                    return [{
                        ...active,
                        direction,
                        node: children,
                        phase: 'settled',
                    }];
                }
                return createSettledLayer(children, direction, nextId, transitionKey);
            });
            return;
        }

        if (renderedKeyRef.current === transitionKey) {
            setLayers((previous) => {
                if (children === null) {
                    return previous.filter((layer) => layer.phase === 'exiting');
                }
                const active = previous.find((layer) => layer.phase !== 'exiting');
                if (!active) {
                    return createSettledLayer(children, direction, sequenceRef.current, transitionKey);
                }
                return previous.map((layer) => layer.id === active.id
                    ? { ...layer, node: children }
                    : layer);
            });
            return;
        }

        cancelPendingWork();
        const nextId = ++sequenceRef.current;
        pendingSequenceRef.current = nextId;
        renderedKeyRef.current = transitionKey;
        setLayers((previous) => {
            const active = previous.find((layer) => layer.phase !== 'exiting');
            const outgoing = active ? [{ ...active, direction, phase: 'exiting' as const }] : [];
            const incoming = children === null ? [] : [{
                direction,
                id: nextId,
                key: transitionKey,
                node: children,
                phase: 'entering' as const,
            }];
            return [...outgoing, ...incoming];
        });

        fallbackRef.current = setTimeout(() => settleTransition(nextId), TRANSITION_FALLBACK_MS);
        frameRef.current = requestAnimationFrame(() => {
            frameRef.current = null;
            if (sequenceRef.current !== nextId || pendingSequenceRef.current !== nextId) return;
            setLayers((previous) => previous.map((layer) => layer.id === nextId && layer.phase === 'entering'
                ? { ...layer, phase: 'active' }
                : layer));
        });
    }, [cancelPendingWork, children, direction, immediate, settleTransition, transitionKey]);

    React.useEffect(() => {
        const mediaQuery = window.matchMedia(REDUCED_MOTION_QUERY);
        const listener = (event: MediaQueryListEvent) => {
            reducedMotionRef.current = event.matches;
            if (!event.matches) return;

            cancelPendingWork();
            pendingSequenceRef.current = null;
            const nextId = ++sequenceRef.current;
            const latest = latestRef.current;
            renderedKeyRef.current = latest.transitionKey;
            setLayers((previous) => {
                if (latest.children === null) return [];
                const active = previous.find((layer) => (
                    layer.phase !== 'exiting' && layer.key === latest.transitionKey
                ));
                if (active) {
                    return [{
                        ...active,
                        direction: latest.direction,
                        node: latest.children,
                        phase: 'settled',
                    }];
                }
                return createSettledLayer(
                    latest.children,
                    latest.direction,
                    nextId,
                    latest.transitionKey,
                );
            });
        };

        reducedMotionRef.current = mediaQuery.matches;
        mediaQuery.addEventListener('change', listener);
        return () => {
            mediaQuery.removeEventListener('change', listener);
            cancelPendingWork();
            pendingSequenceRef.current = null;
        };
    }, [cancelPendingWork]);

    const renderSequence = sequenceRef.current;

    return (
        <View pointerEvents="box-none" style={styles.host} testID={testID}>
            {layers.map((layer) => (
                <PresenceLayerView
                    key={layer.id}
                    layer={layer}
                    onOpacityTransitionEnd={settleTransition}
                    sequence={renderSequence}
                />
            ))}
        </View>
    );
}

const styles = StyleSheet.create({
    host: {
        flex: 1,
        minHeight: 0,
        position: 'relative',
    },
    layer: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
    },
});
