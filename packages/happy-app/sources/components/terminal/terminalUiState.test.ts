import { describe, expect, it } from 'vitest';
import {
    getTerminalCollectionState,
    getTerminalConnectionPresentation,
    getTerminalNotices,
} from './terminalUiState';

describe('terminalUiState', () => {
    it('distinguishes control ownership from connection health', () => {
        expect(getTerminalConnectionPresentation('attached', true)).toEqual({
            label: 'You have control',
            tone: 'success',
        });
        expect(getTerminalConnectionPresentation('attached', false)).toEqual({
            label: 'View only',
            tone: 'info',
        });
        expect(getTerminalConnectionPresentation('reconnecting', false)).toEqual({
            label: 'Reconnecting…',
            tone: 'warning',
        });
    });

    it('uses the reported error message when available', () => {
        expect(getTerminalConnectionPresentation('error', false, 'Socket unavailable')).toEqual({
            label: 'Socket unavailable',
            tone: 'danger',
        });
    });

    it('orders destructive notices before informational truncation', () => {
        expect(getTerminalNotices({
            epochReset: true,
            controlReset: true,
            truncated: true,
        })).toEqual([
            {
                key: 'epoch-reset',
                message: 'Terminal restarted. Unsent keystrokes were discarded.',
            },
            {
                key: 'control-reset',
                message: 'Connection recovered. Some pending keystrokes were discarded.',
            },
            {
                key: 'truncated-output',
                message: 'Older output was trimmed while you were away.',
            },
        ]);
    });

    it('keeps terminal collection states mutually exclusive', () => {
        expect(getTerminalCollectionState({
            online: false,
            loading: true,
            disabled: true,
            error: 'unavailable',
            count: 2,
        })).toBe('offline');
        expect(getTerminalCollectionState({
            online: true,
            loading: false,
            disabled: true,
            error: null,
            count: 0,
        })).toBe('disabled');
        expect(getTerminalCollectionState({
            online: true,
            loading: false,
            disabled: false,
            error: 'unavailable',
            count: 0,
        })).toBe('error');
        expect(getTerminalCollectionState({
            online: true,
            loading: false,
            disabled: false,
            error: null,
            count: 0,
        })).toBe('empty');
        expect(getTerminalCollectionState({
            online: true,
            loading: false,
            disabled: false,
            error: null,
            count: 2,
        })).toBe('ready');
    });
});
