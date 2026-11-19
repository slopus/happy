import { storage } from './storage';
import { discussionMessage, discussionModeMeta } from './discussionMode';
import { resolveMessageModeMeta } from './messageMeta';
import { MMKV } from 'react-native-mmkv';
import { Platform } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { router } from 'expo-router';
import { FirstSubmissionOwner } from './firstSubmission';
import { getFirstSubmissionScope, subscribeFirstSubmissionScope } from './firstSubmissionScope';
import { getServerUrl } from './serverConfig';
import { machineSpawnNewSession } from './ops';
import { sync } from './sync';
import { ensureSessionHydratedWithRetry } from './ensureSessionHydratedWithRetry';
import { configureSpawnedSession } from '@/hooks/useSpawnSession';
import { Modal } from '@/modal';
import { t } from '@/text';
import { traceStartup, type SessionStartupStage } from './sessionStartupTrace';
import { sessionStartupTraceRuntime, type WebStartupTraceHandle } from './sessionStartupTraceRuntime';

const disk = new MMKV({ id: 'first-submission-v1' });
let trace: { id: string; start: number; previous: number; handle: WebStartupTraceHandle } | undefined;
export const firstSubmission = new FirstSubmissionOwner({
    read: scope => Platform.OS === 'web' ? globalThis.localStorage.getItem(`first-submission-v1:${scope}`) ?? undefined : disk.getString(scope),
    save: async (scope, value) => {
        // MMKV's Web implementation may silently fall back to memory. A
        // recoverable submission must fail closed when durable storage fails.
        if (Platform.OS === 'web') {
            const key = `first-submission-v1:${scope}`;
            globalThis.localStorage.setItem(key, value);
            if (globalThis.localStorage.getItem(key) !== value) throw new Error('submission-save-unconfirmed');
            return;
        }
        disk.set(scope, value);
        if (disk.getString(scope) !== value) throw new Error('submission-save-unconfirmed');
    },
    spawn: async (input, live, current) => {
        let approved = false;
        for (;;) {
            if (!current()) return { type: 'cancelled' };
            const result = await machineSpawnNewSession({ machineId: input.machineId,
                directory: live.directory ?? input.path ?? '~', agent: input.agent,
                environmentVariables: live.environmentVariables, approvedNewDirectoryCreation: approved,
                expectedCodexAccountProfileId: input.expectedCodexAccountProfileId,
                ...(trace ? { traceId: trace.id } : {}) });
            if (!current()) return { type: 'cancelled' };
            if (result.type === 'success') {
                if (trace) sessionStartupTraceRuntime.bindSession(trace.handle, result.sessionId);
                return result;
            }
            if (result.type === 'error') {
                // Launch errors are already sanitized by ops. Show the actionable
                // detail transiently; the durable recovery record keeps only state.
                const code = 'codexAccountErrorCode' in result ? result.codexAccountErrorCode : undefined;
                if (code && ['codex-account-unbound', 'codex-account-unavailable', 'profile-not-found', 'binding-version-conflict'].includes(code)) {
                    const open = await Modal.confirm(t('common.error'),
                        t(code === 'codex-account-unbound' ? 'codexAccounts.launchUnbound' : 'codexAccounts.launchUnavailable'),
                        { cancelText: t('common.cancel'), confirmText: t('codexAccounts.openDeviceEnvironment') });
                    if (open && current()) router.push('/settings/device-environment');
                } else {
                    Modal.alert(t('common.error'), result.errorMessage.trim() || t('newSession.submissionFailed'));
                }
                return { type: 'error' };
            }
            approved = await Modal.confirm(t('composeHome.createDirectoryTitle'),
                t('composeHome.createDirectoryMessage', { path: result.directory }),
                { cancelText: t('common.cancel'), confirmText: t('common.create') });
            if (!approved || !current()) return { type: 'cancelled' };
        }
    },
    hydrate: id => {
        const scope = getFirstSubmissionScope();
        return ensureSessionHydratedWithRetry(id, () => scope !== null && getFirstSubmissionScope() === scope && getServerUrl() === scope.serverUrl);
    },
    configure: (id, input) => {
        configureSpawnedSession(id, input);
        if (input.discussing) {
            const state = storage.getState();
            state.applyLocalSettings({ sessionDiscussionModes: { ...state.localSettings.sessionDiscussionModes, [id]: true } });
        }
    },
    send: (id, input, live, current) => sync.sendMessage(id, input.discussing ? discussionMessage(input.prompt) : input.prompt, {
        ...(input.discussing ? {
            displayText: input.text,
            modeMeta: discussionModeMeta(resolveMessageModeMeta(storage.getState().sessions[id], storage.getState().settings), input.agent),
        } : {}),
        source: 'new_session', attachments: live.images.length ? live.images : undefined,
        isCurrent: current,
    }),
    project: receipt => sync.awaitLocalMessageProjection(receipt.sessionId, receipt.localIds, receipt),
    accepted: (_input, live) => live.accepted?.(),
    metric: (phase, saveDuration) => {
        const now = Date.now();
        if (phase === 'saving') {
            const id = randomUUID();
            trace = { id, start: now - saveDuration, previous: now - saveDuration, handle: sessionStartupTraceRuntime.begin(id, typeof performance !== 'undefined' ? performance.now() - saveDuration : now - saveDuration) };
        }
        if (!trace) return;
        const stages: Partial<Record<typeof phase, SessionStartupStage>> = {
            saving: 'web.submission.saved', spawning: 'web.spawn.clicked', hydrating: 'web.session.registered',
            sending: 'web.session.hydrated', projecting: 'web.first_message.queued', ready: 'web.first_message.projected',
        };
        const stage = stages[phase];
        const pending = firstSubmission.getSnapshot();
        if (stage) traceStartup({ traceId: trace.id, stage, timestamp: now, duration: now - trace.previous,
            outcome: 'success', sessionId: pending?.sessionId, machineId: pending?.machineId });
        trace.previous = now;
    },
});
function activate() {
    const owner = getFirstSubmissionScope();
    trace = undefined;
    firstSubmission.activate(owner?.key ?? '', () => Boolean(owner && getFirstSubmissionScope() === owner && getServerUrl() === owner.serverUrl));
}
subscribeFirstSubmissionScope(activate);
activate();

export function traceFirstSubmissionNavigation(sessionId: string) {
    if (!trace) return;
    try { traceStartup({ traceId: trace.id, stage: 'web.session.navigated', timestamp: Date.now(),
        duration: Date.now() - trace.start, outcome: 'success', sessionId }); } catch { /* optional metrics */ }
}
