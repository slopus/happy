import { Platform } from 'react-native';
import { storage } from './storage';
import { resolveSessionState } from '@/utils/sessionUtils';
import type { ApiEphemeralSessionEventUpdate } from './apiTypes';
import type { WebSoundSettingsSchema } from './localSettings';
import type * as z from 'zod';

type WebSoundSettings = z.infer<typeof WebSoundSettingsSchema>;
type SoundEvent = keyof WebSoundSettings['sounds'];
export type SoundChoice = WebSoundSettings['sounds'][SoundEvent];

export const WEB_SOUND_CHOICES: readonly SoundChoice[] = ['off', 'approval', 'complete', 'error', 'start', 'submit'];

const soundFiles: Record<Exclude<SoundChoice, 'off'>, string> = {
    approval: '/sounds/codeisland/8bit_approval.wav',
    complete: '/sounds/codeisland/8bit_complete.wav',
    error: '/sounds/codeisland/8bit_error.wav',
    start: '/sounds/codeisland/8bit_start.wav',
    submit: '/sounds/codeisland/8bit_submit.wav',
};

const claimedEvents = new Set<string>();
const pendingEvents = new Set<string>();
let activeAudio: HTMLAudioElement | null = null;

function wasPlayed(key: string): boolean {
    if (claimedEvents.has(key)) return true;
    try {
        const storageKey = `paws:web-sound:${key}`;
        return Number(localStorage.getItem(storageKey)) > Date.now() - 60_000;
    } catch {
        return false;
    }
}

function markPlayed(key: string): void {
    claimedEvents.add(key);
    if (claimedEvents.size > 300) claimedEvents.clear();
    try {
        localStorage.setItem(`paws:web-sound:${key}`, String(Date.now()));
    } catch {
        // The in-memory claim still prevents repeats in this tab.
    }
}

export async function previewWebSound(choice: SoundChoice, volume: number): Promise<boolean> {
    if (Platform.OS !== 'web' || choice === 'off' || typeof Audio === 'undefined') return false;
    activeAudio?.pause();
    const audio = new Audio(soundFiles[choice]);
    activeAudio = audio;
    audio.volume = Math.max(0, Math.min(1, volume));
    audio.onended = () => { if (activeAudio === audio) activeAudio = null; };
    try {
        await audio.play();
        return true;
    } catch {
        if (activeAudio === audio) activeAudio = null;
        return false;
    }
}

function emitSound(event: SoundEvent, sessionId: string, key: string): void {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const state = storage.getState();
    const settings = state.localSettings?.webSound;
    if (!settings?.enabled || settings.volume === 0) return;
    const choice = settings.sounds[event];
    if (choice === 'off') return;
    if (settings.scope === 'current' && state.currentViewingSessionId !== sessionId) return;
    if (settings.scope === 'pinned' && !state.settings.sessionPinnedOrder.includes(sessionId)) return;
    if (settings.muteViewedSession && document.visibilityState === 'visible'
        && document.hasFocus() && state.currentViewingSessionId === sessionId) return;
    const play = async () => {
        if (pendingEvents.has(key) || wasPlayed(key)) return;
        const currentSettings = storage.getState().localSettings?.webSound;
        if (!currentSettings?.enabled || currentSettings.sounds[event] !== choice) return;
        pendingEvents.add(key);
        try {
            // A browser without playback permission must not silence another tab.
            if (await previewWebSound(choice, currentSettings.volume)) markPlayed(key);
        } finally {
            pendingEvents.delete(key);
        }
    };
    // Serialize the shared localStorage claim where the Web Locks API exists.
    // Other browsers still dedupe sequential updates through localStorage.
    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
        void navigator.locks.request('paws-web-sound-claim', play).catch(() => { void play(); });
    } else {
        void play();
    }
}

export function playWebSessionEventSound(event: ApiEphemeralSessionEventUpdate): void {
    // "done" is a generic readiness signal and can also follow a failed turn.
    // The persisted session transition below is the source of truth for completion.
    if (event.kind === 'done') return;
    const key = `${event.sessionId}:${event.kind}:${event.timestamp}`;
    emitSound(event.kind, event.sessionId, key);
}

let listening = false;

/** Observe real state transitions; an initial history hydration never rings. */
export function startWebSoundAlerts(): void {
    if (listening || Platform.OS !== 'web' || typeof storage.subscribe !== 'function') return;
    listening = true;
    storage.subscribe((next, previous) => {
        if (!next.isDataReady || !previous.isDataReady) return;
        for (const [id, session] of Object.entries(next.sessions)) {
            const prior = previous.sessions[id];
            if (!prior || session === prior) continue;
            const state = resolveSessionState(session).state;
            const oldState = resolveSessionState(prior).state;
            if (state === oldState) continue;
            const turn = session.agentState?.turnStatus;
            const turnKey = `${turn?.turnId ?? ''}:${turn?.updatedAt ?? session.activeAt ?? session.updatedAt}`;
            if (state === 'failed') {
                emitSound('failed', id, `${id}:failed:${turnKey}`);
            } else if (state === 'completed') {
                emitSound('completed', id, `${id}:completed:${turnKey}`);
            } else if (state === 'running' && (oldState === 'idle' || oldState === 'completed' || oldState === 'failed')) {
                emitSound('started', id, `${id}:started:${turnKey}`);
            }
        }
    });
}
