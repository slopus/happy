import { describe, expect, it } from 'vitest';
import { resolveAgentInputPrimaryAction, resolveFollowUpSendControl } from './agentInputPrimaryAction';
import { resolveFollowUpDeliveries } from '@/sync/followUpBehavior';

describe('resolveAgentInputPrimaryAction', () => {
    const base = {
        hasComposerContent: false,
        isSendBlocked: false,
        isSendDisabled: false,
        showAbortButton: false,
        canAbort: true,
    };

    it('shows Stop for a blank composer while the agent is thinking', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            showAbortButton: true,
        })).toBe('stop');
    });

    it('switches to Send as soon as a follow-up has content', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            hasComposerContent: true,
            showAbortButton: true,
        })).toBe('send');
    });

    it('does not show Stop when there is no abort handler', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            showAbortButton: true,
            canAbort: false,
        })).toBe('idle');
    });

    it('keeps an empty idle composer inactive', () => {
        expect(resolveAgentInputPrimaryAction(base)).toBe('idle');
    });

    it('falls back to voice on an empty composer when dictation is available', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            canVoice: true,
        })).toBe('voice');
    });

    it('keeps Stop ahead of voice while the agent is thinking', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            showAbortButton: true,
            canVoice: true,
        })).toBe('stop');
    });

    it('keeps Send ahead of voice once there is content', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            hasComposerContent: true,
            canVoice: true,
        })).toBe('send');
    });

    it('still offers Stop for a blank composer when steering is blocked', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            isSendBlocked: true,
            showAbortButton: true,
            canVoice: true,
        })).toBe('stop');
    });

    it('preserves the blocked-send affordance for content', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            hasComposerContent: true,
            isSendBlocked: true,
            showAbortButton: true,
        })).toBe('blocked');
    });
});

describe('resolveFollowUpSendControl', () => {
    it('offers the alternate gesture only when the setting leaves one', () => {
        expect(resolveFollowUpSendControl('send', resolveFollowUpDeliveries('steer'))).toEqual({ plain: 'steer', alternate: 'queue' });
        expect(resolveFollowUpSendControl('send', resolveFollowUpDeliveries('queue'))).toEqual({ plain: 'queue', alternate: 'steer' });
        expect(resolveFollowUpSendControl('send', resolveFollowUpDeliveries('alwaysSteer'))).toEqual({ plain: 'steer', alternate: null });
        expect(resolveFollowUpSendControl('send', resolveFollowUpDeliveries('alwaysQueue'))).toEqual({ plain: 'queue', alternate: null });
    });

    it('is absent while the agent is idle or its daemon ignores deliveries', () => {
        expect(resolveFollowUpSendControl('send', undefined)).toBeNull();
    });

    it.each(['stop', 'blocked', 'voice', 'idle'] as const)('is absent when the button is not a send (%s)', (action) => {
        expect(resolveFollowUpSendControl(action, resolveFollowUpDeliveries('steer'))).toBeNull();
    });
});
