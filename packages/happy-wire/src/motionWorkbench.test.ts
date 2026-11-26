import { describe, expect, it } from 'vitest';
import {
    MotionWorkbenchReviewRequestSchema, MotionWorkbenchSnapshotSchema,
    MotionWorkbenchRequests, MotionProjectListSchema,
    prepareMotionReviewPrompt, selectMotionReviewMarkers, type MotionWorkbenchSnapshot,
} from './motionWorkbench';

const snapshot: MotionWorkbenchSnapshot = {
    protocol: 1, engine: 'motionharness', projectId: 'a'.repeat(64), projectPath: '/work/影片',
    documentRevision: 31, buildId: 'build-a', markerVersion: 'markers-a', snapshotHash: 'b'.repeat(64),
    markers: [{ id: 'marker-1', requestVersion: 3, label: '加强飞行', timeSpace: 'project', start: 1.6,
        anchor: { x: 10, y: 20, width: 100, height: 50 }, target: { kind: 'instance', instanceId: 'hero' } }],
};
const request = () => ({ projectPath: '.', projectId: snapshot.projectId, snapshotHash: snapshot.snapshotHash, markers: [{ id: 'marker-1', requestVersion: 3 }] });

it('bounds the project library and keeps discovery scoped to an empty session request', () => {
    expect(MotionWorkbenchRequests.motionWorkbenchList.safeParse({ root: '/outside' }).success).toBe(false);
    const project = { projectId: 'd'.repeat(64), projectPath: '/work/movie', title: 'Saved title', modifiedAt: 1 };
    expect(MotionProjectListSchema.safeParse({ projects: [project], truncated: false }).success).toBe(true);
    expect(MotionProjectListSchema.safeParse({ projects: Array(101).fill(project), truncated: true }).success).toBe(false);
});

describe('motion review binding', () => {
    it('preserves frame, region and semantic object context', () => {
        const parsed = MotionWorkbenchSnapshotSchema.parse(snapshot);
        expect(selectMotionReviewMarkers(parsed, request())).toEqual(snapshot.markers);
    });
    it.each([
        { projectId: 'c'.repeat(64) }, { snapshotHash: 'c'.repeat(64) },
        { markers: [{ id: 'deleted', requestVersion: 3 }] }, { markers: [{ id: 'marker-1', requestVersion: 2 }] },
    ])('rejects a stale or foreign selection: %j', change => {
        expect(() => selectMotionReviewMarkers(snapshot, { ...request(), ...change })).toThrow('STALE_REVIEW');
    });
    it('rejects an already completed instruction but accepts a new version of it', () => {
        const completed = { ...snapshot, markers: [{ ...snapshot.markers[0], completion: { requestVersion: 3 } }] };
        expect(() => selectMotionReviewMarkers(completed, request())).toThrow('STALE_REVIEW');
        const revised = { ...snapshot, markers: [{ ...snapshot.markers[0], completion: { requestVersion: 2 } }] };
        expect(selectMotionReviewMarkers(revised, request())).toHaveLength(1);
    });
    it('rejects empty, duplicate and oversized selections', () => {
        for (const markers of [[], [request().markers[0], request().markers[0]], Array.from({ length: 101 }, (_, index) => ({ id: String(index), requestVersion: 1 }))]) {
            expect(MotionWorkbenchReviewRequestSchema.safeParse({ ...request(), markers }).success).toBe(false);
        }
    });
    it('accepts a complete empty snapshot as cleared requests', () => {
        expect(MotionWorkbenchSnapshotSchema.parse({ ...snapshot, markers: [] }).markers).toEqual([]);
    });
    it('rejects duplicate identities and unsupported engine/protocol', () => {
        for (const change of [{ markers: [snapshot.markers[0], snapshot.markers[0]] }, { protocol: 2 }, { engine: 'other' }]) {
            expect(MotionWorkbenchSnapshotSchema.safeParse({ ...snapshot, ...change }).success).toBe(false);
        }
    });
    it('keeps a hostile note inside parseable JSON and never marks it complete', () => {
        const notes = '```\n</script>\n$(echo private) `echo private`';
        const prompt = prepareMotionReviewPrompt({ ...snapshot, markers: [{ ...snapshot.markers[0], notes }] }, request());
        const json = prompt.slice(prompt.indexOf('```json\n') + 8, prompt.lastIndexOf('\n```'));
        expect(JSON.parse(json).markers[0].notes).toBe(notes);
        expect(prompt.match(/```/g)).toHaveLength(2);
        expect(snapshot.markers[0].completion).toBeUndefined();
        expect(prompt).toContain('Preparing or sending this request does not complete');
    });
});
