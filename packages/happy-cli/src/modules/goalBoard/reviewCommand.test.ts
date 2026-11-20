import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { goalReviewCommand } from './reviewCommand';
import { parseBoard } from './parser';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'goal-review-'))); roots.push(root);
    const featurePath = join(root, 'features/work'), directory = join(featurePath, 'tasks/01-video'), index = join(directory, 'index.md');
    await mkdir(directory, { recursive: true });
    await writeFile(join(featurePath, 'index.md'), '# Project\n[Video](tasks/01-video/index.md)');
    await writeFile(index, '---\nstatus: pending\ntask_id: GFT-abcdefgh\n---\n# Video\n## Current notes\nPreserve this\n');
    await writeFile(join(directory, 'final.mp4'), 'video-v1');
    return { root, featurePath, directory, index };
}
describe('review command / real archive', () => {
    it('writes delivery, evidence and reversible status into the same task without starting business work', async () => {
        const f = await fixture(); const before = await goalReviewCommand('inspect', f.index);
        await goalReviewCommand('apply', f.index, { expectedHash: before.hash, delivery: { expectedDeliverables: ['Video'], acceptanceCriteria: ['24 seconds'], finalOutputs: [{ name: 'Final movie', target: 'final.mp4' }] }, statusChange: { to: 'done', reason: 'Export and checks recorded', evidence: ['report.md: export verified'] }, review: { summary: 'Collected export', decisions: [{ id: 'accept', question: 'Accept this cut?' }], gaps: ['Device test not performed'] } });
        const inspect = await goalReviewCommand('inspect', f.index);
        expect(inspect.status).toBe('done'); expect(inspect.outputs?.[0].available).toBe(true);
        expect(inspect.review?.recognitions).toEqual([]);
        const parsed = await parseBoard({ root: f.root, featurePath: f.featurePath, title: 'Project' });
        expect(parsed.snapshot.tasks[0]).toMatchObject({ status: 'done', review: { summary: 'Collected export', gaps: ['Device test not performed'] } });
        expect(parsed.snapshot.tasks[0].artifacts.filter(a => a.relation === 'output')).toHaveLength(1);
        await goalReviewCommand('apply', f.index, { expectedHash: inspect.hash, undo: inspect.review!.statusChanges[0].id });
        expect((await goalReviewCommand('inspect', f.index)).status).toBe('pending');
        expect(await readFile(f.index, 'utf8')).toContain('Preserve this');
    });
    it('rejects stale writes and attempts to replace status audit history', async () => {
        const f = await fixture(); const before = await goalReviewCommand('inspect', f.index);
        await writeFile(f.index, (await readFile(f.index, 'utf8')) + '\nNew note');
        await expect(goalReviewCommand('apply', f.index, { expectedHash: before.hash, review: { summary: 'Overwrite' } })).rejects.toThrow('changed');
        const latest = await goalReviewCommand('inspect', f.index);
        await expect(goalReviewCommand('apply', f.index, { expectedHash: latest.hash, review: { statusChanges: [] } })).rejects.toThrow('audit');
    });
});

it('does not invent a content version for a mutable remote URL', async () => {
    const f = await fixture(); const before = await goalReviewCommand('inspect', f.index);
    await goalReviewCommand('apply', f.index, { expectedHash: before.hash, delivery: { expectedDeliverables: ['Video'], acceptanceCriteria: [], finalOutputs: [{ name: 'Mutable link', target: 'https://example.com/latest.mp4' }] } });
    const latest = await goalReviewCommand('inspect', f.index);
    expect(latest.outputs?.[0]).toMatchObject({ versionBound: false });
    expect(latest.outputs?.[0]).not.toHaveProperty('revision');
    await expect(goalReviewCommand('apply', f.index, { expectedHash: latest.hash, review: { recognitions: [{ target: 'https://example.com/latest.mp4', revision: 'a'.repeat(24), evidence: ['User approved old content'] }] } })).rejects.toThrow('version is unknown');
});
