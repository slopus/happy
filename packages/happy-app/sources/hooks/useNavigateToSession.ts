import type { Router } from "expo-router"
import { useRouter } from "expo-router"
import { useCallback } from 'react';
import { Platform } from 'react-native';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { trackSessionSwitched } from '@/track';
import { perfMark } from '@/utils/perfLog';
import { isRunningOnMac } from '@/utils/platform';

function sessionHref(sessionId: string): `/session/${string}` {
    return `/session/${encodeURIComponent(sessionId)}`;
}

// expo-router's `dangerouslySingular: true` keys on getSingularId(name, params),
// which substitutes the dynamic segment ("session/[id]" -> "session/<id>"),
// so every session would still get its own route. Keying on the bare route
// name makes all `session/[id]` entries collapse into one.
export function singularSessionRoute(name: string): string {
    return name;
}

export function prefetchSession(router: Router, sessionId: string) {
    // Native stack owns the off-screen instance. Web keeps its current
    // navigation behavior; mounting its file/sidebar tree is not a warmup.
    if (Platform.OS === 'web' || isRunningOnMac() || !storage.getState().sessions[sessionId]
        || storage.getState().currentViewingSessionId === sessionId) {
        return;
    }
    perfMark(`session-preload:${sessionId}`);
    sync.preloadSession(sessionId);
    try {
        router.prefetch(sessionHref(sessionId));
    } catch (error) {
        // Preparation is optional; a failed hint must not break the press.
        console.warn('Unable to prefetch session screen', error);
    }
}

export function navigateToSession(router: Router, sessionId: string) {
    perfMark(`session-open:${sessionId}`);
    const session = storage.getState().sessions[sessionId];
    if (session) {
        trackSessionSwitched();
    }

    if (Platform.OS === 'web') {
        // Web has no screen recycling: @react-navigation/native-stack keeps
        // every pushed route mounted (unfocused ones only get display:none),
        // so each opened session would keep its ChatList, store subscriptions
        // and document listeners alive for the life of the tab. Keep one
        // session route in the web stack; Back then returns to the list.
        router.push(sessionHref(sessionId), { dangerouslySingular: singularSessionRoute });
        return;
    }
    router.push(sessionHref(sessionId));
}

/**
 * Replace a session destination while keeping the web stack singular. Expo
 * Router's web REPLACE action bypasses its singular filter; dismissTo uses the
 * installed POP_TO action instead, which reuses the existing session route and
 * removes routes above it. Native keeps the platform's normal replace action.
 */
export function replaceToSession(router: Router, sessionId: string) {
    if (Platform.OS === 'web') {
        router.dismissTo(sessionHref(sessionId));
        return;
    }
    router.replace(sessionHref(sessionId));
}

export function useNavigateToSession() {
    const router = useRouter();
    return useCallback((sessionId: string) => {
        navigateToSession(router, sessionId);
    }, [router]);
}

/** Pressable owns tap cancellation, scrolling and long-press recognition. */
export function useSessionPressHandlers(sessionId: string) {
    const router = useRouter();
    const onPressIn = useCallback(() => prefetchSession(router, sessionId), [router, sessionId]);
    const onPress = useCallback(() => navigateToSession(router, sessionId), [router, sessionId]);
    return { onPressIn, onPress };
}
