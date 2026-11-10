import * as React from 'react';
import { AppState, Platform } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { sessionComposerPrediction, sessionCancelComposerPrediction } from '@/sync/ops';

export type ComposerPredictionSource = {
    turnId: string;
    contextKey: string;
    enabled: boolean;
    /** Sampling may overlap final history sync; display still waits for it. */
    readyToDisplay?: boolean;
};

function isForeground(): boolean {
    return Platform.OS === 'web' && typeof document !== 'undefined'
        ? document.visibilityState === 'visible' && document.hasFocus()
        : AppState.currentState === 'active';
}

/** Event-driven, once-per-source prediction. Input notifications invalidate synchronously,
 * before React's deferred draft mirror; an unaccepted result never becomes draft content. */
export function useComposerPrediction(sessionId: string, source: ComposerPredictionSource | undefined, getText: () => string) {
    const [foreground, setForeground] = React.useState(isForeground);
    const [candidate, setCandidate] = React.useState<{ key: string; text: string } | null>(null);
    const cached = React.useRef<{ key: string; text: string } | null>(null);
    const attempted = React.useRef(new Set<string>());
    const generation = React.useRef(0);
    const pending = React.useRef<string | null>(null);
    const key = JSON.stringify([sessionId, source?.turnId, source?.contextKey]);
    const enabled = !!source?.enabled && foreground;
    const latest = React.useRef({ key, enabled, getText });
    latest.current = { key, enabled, getText };

    // Input hides a valid cached candidate, but deleting the draft can restore it
    // without another model request. Pending inference is still cancelled exactly.
    const onInputActivity = React.useCallback(() => {
        generation.current++;
        setCandidate(null);
        const requestId = pending.current;
        pending.current = null;
        if (requestId) void sessionCancelComposerPrediction(sessionId, requestId).catch(() => {});
    }, [sessionId]);

    const invalidate = React.useCallback(() => {
        cached.current = null;
        onInputActivity();
    }, [onInputActivity]);

    const onTextChange = React.useCallback((text: string) => {
        onInputActivity();
        if (text === '' && latest.current.enabled && cached.current?.key === latest.current.key) {
            setCandidate(cached.current);
        }
    }, [onInputActivity]);

    React.useEffect(() => {
        const update = () => {
            const active = isForeground();
            if (!active) invalidate();
            setForeground(active);
        };
        const subscription = AppState.addEventListener('change', update);
        if (Platform.OS === 'web' && typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', update);
            window.addEventListener('focus', update);
            window.addEventListener('blur', update);
        }
        return () => {
            subscription.remove();
            if (Platform.OS === 'web' && typeof document !== 'undefined') {
                document.removeEventListener('visibilitychange', update);
                window.removeEventListener('focus', update);
                window.removeEventListener('blur', update);
            }
        };
    }, [invalidate]);

    React.useEffect(() => {
        const sourceKey = JSON.stringify([sessionId, source?.turnId]);
        if (!enabled || !source?.turnId || latest.current.getText() !== '' || attempted.current.has(sourceKey)) return;
        let active = true;
        const admissionEpoch = generation.current;
        // Defer admission until effects settle, so StrictMode's setup/cleanup probe
        // does not consume the sole attempt or start a disposable model request.
        void Promise.resolve().then(() => {
            if (!active || generation.current !== admissionEpoch || !latest.current.enabled || latest.current.getText() !== '') return;
            attempted.current.add(sourceKey);
            if (attempted.current.size > 32) attempted.current.delete(attempted.current.values().next().value!);
            const requestId = randomUUID();
            const epoch = generation.current;
            pending.current = requestId;
            void sessionComposerPrediction(sessionId, { requestId, sourceTurnId: source.turnId }).then(response => {
                if (epoch !== generation.current || latest.current.key !== key || !latest.current.enabled
                    || latest.current.getText() !== '' || response.sourceTurnId !== source.turnId) return;
                if (response.status === 'ready' && response.text) {
                    cached.current = { key, text: response.text };
                    setCandidate(cached.current);
                }
            }).catch(() => {}).finally(() => {
                if (pending.current === requestId) pending.current = null;
            });
        });
        return () => { active = false; invalidate(); };
    }, [enabled, key, sessionId, source?.turnId, invalidate]);

    return { text: enabled && source?.readyToDisplay !== false && candidate?.key === key && getText() === '' ? candidate.text : null,
        invalidate, onInputActivity, onTextChange };
}
