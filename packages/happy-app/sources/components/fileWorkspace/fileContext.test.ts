import { describe, expect, it } from 'vitest';
import { buildFileContextMessage } from './fileContext';
describe('file context sent to model', () => {
    it('binds an explicit path and baseline hash while preserving the original draft separately', () => {
        const result = buildFileContextMessage('把标题改短', { path: '/work/docs/方案.md', hash: 'sha256:baseline', quote: '旧标题' });
        expect(result.draftText).toBe('把标题改短');
        expect(result.text).toContain('/work/docs/方案.md');
        expect(result.text).toContain('sha256:baseline');
        expect(result.text).toContain('旧标题');
        expect(result.text).toContain('Re-read');
    });
    it('leaves slash commands and unreferenced chat unchanged', () => {
        expect(buildFileContextMessage('/compact', { path: '/work/x', hash: 'h' })).toEqual({ text: '/compact' });
        expect(buildFileContextMessage('hello', null)).toEqual({ text: 'hello' });
    });
});

it('freezes a named native project version without treating its snapshot hash as a file hash', () => {
    const motion = { projectId: 'a'.repeat(64), projectPath: '/work/film', title: 'Brand film', documentRevision: 12, buildId: 'build-12', markerVersion: 'markers-3', snapshotHash: 'b'.repeat(64) };
    const reference = { path: '/work/film/mh.json', hash: motion.snapshotHash, motion };
    const queued = buildFileContextMessage('Make the opening faster', reference);
    motion.buildId = 'new-build';
    expect(queued.fileReference?.motion?.buildId).toBe('build-12');
    expect(queued.text).toContain('Motion project modification target');
    expect(queued.text).toContain('build-12');
    expect(queued.text).toContain('stop and report');
    expect(queued.text).not.toContain('[Workspace file context]');
});
