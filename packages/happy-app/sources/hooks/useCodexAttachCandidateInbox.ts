import * as React from 'react';
import { AppState } from 'react-native';
import { create } from 'zustand';

import {
    attachCodexCandidate,
    dismissCodexCandidate,
    listCodexAttachCandidates,
    type MachineCodexAttachCandidate,
} from '@/sync/codexAttachCandidates';
import { useAllMachines, useAllSessions } from '@/sync/storage';

const POLL_INTERVAL_MS = 15_000;

type CandidateInboxState = {
    candidates: MachineCodexAttachCandidate[];
    loading: boolean;
    error: string | null;
    busyThreadId: string | null;
    refresh: (
        machines: Array<{ id: string; name: string }>,
        existingThreadIds: string[],
    ) => Promise<void>;
    attach: (candidate: MachineCodexAttachCandidate) => Promise<string>;
    dismiss: (candidate: MachineCodexAttachCandidate) => Promise<void>;
};

let refreshInFlight: Promise<void> | null = null;

const useCandidateInboxStore = create<CandidateInboxState>((set) => ({
    candidates: [],
    loading: true,
    error: null,
    busyThreadId: null,
    refresh: async (machines, existingThreadIds) => {
        if (refreshInFlight) return refreshInFlight;
        refreshInFlight = (async () => {
            if (machines.length === 0) {
                set({ candidates: [], loading: false, error: null });
                return;
            }
            try {
                const results = await Promise.allSettled(machines.map(async (machine) => {
                    const candidates = await listCodexAttachCandidates(machine.id, existingThreadIds);
                    return candidates.map((candidate) => ({
                        ...candidate,
                        machineId: machine.id,
                        machineName: machine.name,
                    }));
                }));
                const fulfilled = results.filter(
                    (result): result is PromiseFulfilledResult<MachineCodexAttachCandidate[]> => result.status === 'fulfilled',
                );
                if (fulfilled.length === 0) {
                    const firstError = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
                    throw firstError?.reason ?? new Error('Unable to scan Codex Desktop sessions');
                }
                const candidates = fulfilled
                    .flatMap((result) => result.value)
                    .sort((a, b) => b.updatedAt - a.updatedAt);
                set({ candidates, loading: false, error: null });
            } catch (error) {
                set({ loading: false, error: error instanceof Error ? error.message : String(error) });
            }
        })().finally(() => {
            refreshInFlight = null;
        });
        return refreshInFlight;
    },
    attach: async (candidate) => {
        set({ busyThreadId: candidate.threadId, error: null });
        try {
            const result = await attachCodexCandidate(candidate.machineId, candidate.threadId);
            set((state) => ({
                candidates: state.candidates.filter((item) => item.threadId !== candidate.threadId),
                busyThreadId: null,
            }));
            return result.sessionId;
        } catch (error) {
            set({
                busyThreadId: null,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    },
    dismiss: async (candidate) => {
        set({ busyThreadId: candidate.threadId, error: null });
        try {
            await dismissCodexCandidate(candidate.machineId, candidate.threadId);
            set((state) => ({
                candidates: state.candidates.filter((item) => item.threadId !== candidate.threadId),
                busyThreadId: null,
            }));
        } catch (error) {
            set({
                busyThreadId: null,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    },
}));

export function useCodexAttachCandidateInbox(): CandidateInboxState {
    const machines = useAllMachines();
    const sessions = useAllSessions();
    const inbox = useCandidateInboxStore();
    const machineInputs = React.useMemo(() => machines.map((machine) => ({
        id: machine.id,
        name: machine.metadata?.displayName || machine.metadata?.host || machine.id,
    })), [machines]);
    const existingThreadIds = React.useMemo(() => sessions
        .map((session) => session.metadata?.codexThreadId)
        .filter((threadId): threadId is string => Boolean(threadId))
        .slice(0, 5000)
        .sort(), [sessions]);
    const machineSignature = machineInputs.map((machine) => `${machine.id}:${machine.name}`).join('|');
    const threadSignature = existingThreadIds.join('|');

    React.useEffect(() => {
        let interval: ReturnType<typeof setInterval> | null = null;
        const stopPolling = () => {
            if (interval) clearInterval(interval);
            interval = null;
        };
        const startPolling = () => {
            stopPolling();
            void inbox.refresh(machineInputs, existingThreadIds);
            interval = setInterval(() => {
                void inbox.refresh(machineInputs, existingThreadIds);
            }, POLL_INTERVAL_MS);
        };

        if (AppState.currentState === 'active') startPolling();
        const subscription = AppState.addEventListener('change', (state) => {
            if (state === 'active') startPolling();
            else stopPolling();
        });

        return () => {
            stopPolling();
            subscription.remove();
        };
    }, [machineSignature, threadSignature]);

    return inbox;
}
