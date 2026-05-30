import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendRunReviewEvent, createRunReviewEvent, getFinalRunReviewEvent, getRunReviewEvents } from './runReviewState';
import { MetadataSchema, type Metadata } from './storageTypes';

const baseMetadata: Metadata = {
    path: '/repo',
    host: 'dev',
};

describe('run review state', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('persists accept events through session metadata parsing', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.123456);
        const accepted = createRunReviewEvent('accepted', 1000);

        const metadata = MetadataSchema.parse({
            ...baseMetadata,
            runReviewEvents: appendRunReviewEvent([], accepted),
        });

        expect(getRunReviewEvents(metadata)).toEqual([accepted]);
        expect(getFinalRunReviewEvent(getRunReviewEvents(metadata))).toEqual(accepted);
    });

    it('requires a note before flagging a run', () => {
        expect(() => appendRunReviewEvent([], createRunReviewEvent('flagged', 1000))).toThrow(
            'Flagged run review events require a note.',
        );

        const flagged = createRunReviewEvent('flagged', 1000, 'unexpected permission escalation');
        expect(appendRunReviewEvent([], flagged)).toEqual([flagged]);
    });

    it('keeps finalized decisions read-only after reload', () => {
        const accepted = createRunReviewEvent('accepted', 1000);
        const reloadedEvents = getRunReviewEvents(MetadataSchema.parse({
            ...baseMetadata,
            runReviewEvents: [accepted],
        }));

        const flagged = createRunReviewEvent('flagged', 2000, 'second decision');
        expect(appendRunReviewEvent(reloadedEvents, flagged)).toBe(reloadedEvents);
        expect(getFinalRunReviewEvent(reloadedEvents)).toEqual(accepted);
    });

    it('appends follow-up notes without mutating the final decision', () => {
        const accepted = createRunReviewEvent('accepted', 1000);
        const note = createRunReviewEvent('note', 2000, 'follow-up evidence copied');
        const nextEvents = appendRunReviewEvent([accepted], note);

        expect(nextEvents).toEqual([accepted, note]);
        expect(getFinalRunReviewEvent(nextEvents)).toEqual(accepted);
    });
});
