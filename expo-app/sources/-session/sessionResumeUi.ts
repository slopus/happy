export type InactiveSessionNoticeKind = 'none' | 'not-resumable' | 'machine-offline';

export type InactiveSessionUiState = Readonly<{
    shouldShowInput: boolean;
    inactiveStatusTextKey: 'session.inactiveResumable' | 'session.inactiveMachineOffline' | 'session.inactiveNotResumable' | null;
    noticeKind: InactiveSessionNoticeKind;
}>;

export function getInactiveSessionUiState(opts: {
    isSessionActive: boolean;
    isResumable: boolean;
    isMachineOnline: boolean;
}): InactiveSessionUiState {
    if (opts.isSessionActive) {
        return { shouldShowInput: true, inactiveStatusTextKey: null, noticeKind: 'none' };
    }

    if (!opts.isResumable) {
        return {
            shouldShowInput: false,
            inactiveStatusTextKey: 'session.inactiveNotResumable',
            noticeKind: 'not-resumable',
        };
    }

    if (!opts.isMachineOnline) {
        return {
            shouldShowInput: false,
            inactiveStatusTextKey: 'session.inactiveMachineOffline',
            noticeKind: 'machine-offline',
        };
    }

    return {
        shouldShowInput: true,
        inactiveStatusTextKey: 'session.inactiveResumable',
        noticeKind: 'none',
    };
}

