import { describe, expect, it } from 'vitest';
import { GoalTaskSchema, GoalBoardSnapshotSchema, GoalBoardArtifactResponseSchema } from './goalBoard';

describe('Goal Board wire contract', () => {
    it('preserves unknown status when task status is absent or invalid', () => {
        const task = { id: 'a', title: 'Task', indexPath: '/goals/task/index.md', goal: '', dependencies: [], expectedDeliverables: [], artifacts: [] };
        expect(GoalTaskSchema.parse(task).status).toBe('unknown');
        expect(GoalTaskSchema.parse({ ...task, status: 'completed' }).status).toBe('unknown');
        expect(GoalTaskSchema.parse({ ...task, status: 'review' }).status).toBe('review');
    });
    it('bounds encrypted metadata snapshots', () => {
        expect(GoalBoardSnapshotSchema.safeParse({ featurePath: 'x', title: 'x', revision: 'x', updatedAt: 0, tasks: [], warnings: [] }).success).toBe(true);
        expect(GoalBoardSnapshotSchema.safeParse({ featurePath: 'x', title: 'x', revision: 'x', updatedAt: 0, tasks: Array(201).fill({}), warnings: [] }).success).toBe(false);
    });
    it('validates attachment identity, lane, MIME and bounded payload size', () => {
        const response = { success: true, kind: 'attachment', attachment: { ref: 'ref', name: '报告.pdf', size: 1024, mimeType: 'application/pdf', kind: 'file', encrypted: true } };
        expect(GoalBoardArtifactResponseSchema.safeParse(response).success).toBe(true);
        expect(GoalBoardArtifactResponseSchema.safeParse({ ...response, attachment: { ...response.attachment, ref: '' } }).success).toBe(false);
        expect(GoalBoardArtifactResponseSchema.safeParse({ ...response, attachment: { ...response.attachment, mimeType: 'invalid MIME' } }).success).toBe(false);
        expect(GoalBoardArtifactResponseSchema.safeParse({ ...response, attachment: { ...response.attachment, size: 500 * 1024 * 1024 + 1 } }).success).toBe(false);
    });

});

it('validates a separate metadata-free manifest projection without loosening the raw ciphertext contract', async () => {
    const wire = await import('./goalBoard');
    const envelope = { projectPath: '/project', snapshotId: 'snapshot', catalogFingerprint: 'a'.repeat(64), total: 1, nextCursor: null, hasNext: false, expiresAt: 1000 };
    const manifest = { ...envelope, format: 'manifest', sessions: [{ id: 'one', metadataVersion: 3 }] };
    expect(wire.GoalProjectConversationCatalogManifestPageSchema.parse(manifest)).toEqual(manifest);
    expect(wire.GoalProjectConversationCatalogPageSchema.safeParse(manifest).success).toBe(false);
    const raw = { ...envelope, sessions: [{ id: 'one', metadataVersion: 3, metadata: Buffer.from('encrypted').toString('base64'), dataEncryptionKey: null }] };
    expect(wire.GoalProjectConversationCatalogPageSchema.safeParse(raw).success).toBe(true);
    expect(wire.GoalProjectConversationCatalogManifestPageSchema.safeParse(raw).success).toBe(false);
    for (const bad of [
        { ...manifest, format: 'raw' },
        { ...manifest, sessions: [{ id: '', metadataVersion: 1 }] },
        { ...manifest, sessions: [{ id: 'one', metadataVersion: -1 }] },
        { ...manifest, total: 20001 },
        { ...manifest, sessions: Array(20001).fill({ id: 'one', metadataVersion: 1 }) },
    ]) expect(wire.GoalProjectConversationCatalogManifestPageSchema.safeParse(bad).success).toBe(false);
    const projected = wire.GoalProjectConversationCatalogManifestPageSchema.parse({ ...manifest, sessions: raw.sessions });
    expect(Object.keys(projected.sessions[0]).sort()).toEqual(['id', 'metadataVersion']);
});

it('preserves explicit compact classification while keeping missing manifest classifications opaque', async () => {
    const wire = await import('./goalBoard');
    const page = { projectPath: '/project', snapshotId: 'snapshot', catalogFingerprint: 'a'.repeat(64), total: 3, nextCursor: null, hasNext: false, expiresAt: 1000,
        format: 'manifest', indexSupported: true, sessions: [
            { id: 'own', metadataVersion: 2, candidate: { sessionId: 'own', metadataVersion: 2, directory: '/project', title: 'Owned' } },
            { id: 'foreign', metadataVersion: 1, candidate: null },
            { id: 'opaque', metadataVersion: 1 },
        ] };
    expect(wire.GoalProjectConversationCatalogManifestPageSchema.parse(page)).toEqual(page);
    for (const candidate of [
        { sessionId: 'wrong-id', metadataVersion: 2, directory: '/project', title: 'Wrong' },
        { sessionId: 'own', metadataVersion: 3, directory: '/project', title: 'Wrong' },
    ]) expect(wire.GoalProjectConversationCatalogManifestPageSchema.safeParse({ ...page, sessions: [{ id: 'own', metadataVersion: 2, candidate }] }).success).toBe(false);
});

it('requires explicit identity-bound evidence for a compact index update', async () => {
    const wire = await import('./goalBoard');
    expect(wire.GoalProjectConversationIndexEntrySchema.parse({ id: 'foreign', metadataVersion: 3, candidate: null })).toEqual({ id: 'foreign', metadataVersion: 3, candidate: null });
    expect(wire.GoalProjectConversationIndexEntrySchema.safeParse({ id: 'opaque', metadataVersion: 3 }).success).toBe(false);
    expect(wire.GoalProjectConversationIndexEntrySchema.safeParse({ id: 'own', metadataVersion: 3, candidate: { sessionId: 'own', metadataVersion: 2, directory: '/project', title: 'Wrong version' } }).success).toBe(false);
});
