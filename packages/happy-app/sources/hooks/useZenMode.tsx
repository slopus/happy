import * as React from 'react';
import { Platform } from 'react-native';

// Zen mode: hides both side panels, center column fills the window.
// State persisted to localStorage. Toggled via Cmd/Ctrl+0.
const ZEN_KEY = 'happy_zen_mode';

function getInitialZen(): boolean {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
    try {
        return localStorage.getItem(ZEN_KEY) === 'true';
    } catch {
        return false;
    }
}

const ZenContext = React.createContext<{
    zen: boolean;
    toggleZen: () => void;
}>({ zen: false, toggleZen: () => {} });

export const ZenModeProvider = React.memo(({ children }: { children: React.ReactNode }) => {
    const [zen, setZen] = React.useState(getInitialZen);

    const toggleZen = React.useCallback(() => {
        setZen(prev => {
            const next = !prev;
            try { localStorage.setItem(ZEN_KEY, String(next)); } catch {}
            return next;
        });
    }, []);

    const value = React.useMemo(() => ({ zen, toggleZen }), [zen, toggleZen]);

    return (
        <ZenContext.Provider value={value}>
            {children}
        </ZenContext.Provider>
    );
});

export function useZenMode() {
    return React.useContext(ZenContext);
}
