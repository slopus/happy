import { describe, expect, it } from 'vitest';

import { getInactiveSessionUiState } from './sessionResumeUi';

describe('getInactiveSessionUiState', () => {
    it('shows input for active sessions', () => {
        expect(getInactiveSessionUiState({
            isSessionActive: true,
            isResumable: false,
            isMachineOnline: false,
        })).toEqual({
            shouldShowInput: true,
            inactiveStatusTextKey: null,
            noticeKind: 'none',
        });
    });

    it('hides input and shows a not-resumable notice when vendor resume is not available', () => {
        expect(getInactiveSessionUiState({
            isSessionActive: false,
            isResumable: false,
            isMachineOnline: true,
        })).toEqual({
            shouldShowInput: false,
            inactiveStatusTextKey: 'session.inactiveNotResumable',
            noticeKind: 'not-resumable',
        });
    });

    it('hides input and shows a machine-offline notice when the machine is offline', () => {
        expect(getInactiveSessionUiState({
            isSessionActive: false,
            isResumable: true,
            isMachineOnline: false,
        })).toEqual({
            shouldShowInput: false,
            inactiveStatusTextKey: 'session.inactiveMachineOffline',
            noticeKind: 'machine-offline',
        });
    });

    it('shows input for inactive resumable sessions when machine is online', () => {
        expect(getInactiveSessionUiState({
            isSessionActive: false,
            isResumable: true,
            isMachineOnline: true,
        })).toEqual({
            shouldShowInput: true,
            inactiveStatusTextKey: 'session.inactiveResumable',
            noticeKind: 'none',
        });
    });
});

