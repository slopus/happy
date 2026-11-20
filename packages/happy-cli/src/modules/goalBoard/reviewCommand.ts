import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { changeGoalTaskStatus, undoGoalTaskStatus, readGoalTaskStatus, readGoalReview, writeGoalReview, emptyGoalReview, GoalReviewSchema, GoalDeliveryAgreementSchema, readGoalDeliveryAgreement, writeGoalDeliveryAgreement } from '@slopus/happy-wire';
import { readBoundedFile, goalFileRevision } from './parser';
import { safePath } from './catalog';
import { createWorkspaceFileHandlers } from '../common/workspaceFiles';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const patchSchema = z.object({
    expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
    delivery: GoalDeliveryAgreementSchema.optional(),
    review: z.record(z.string(), z.unknown()).optional(),
    statusChange: z.object({ to: z.enum(['pending', 'running', 'review', 'done', 'blocked']), reason: z.string().trim().min(1).max(2048), evidence: z.array(z.string().trim().min(1).max(2048)).min(1).max(30) }).optional(),
    undo: z.string().min(1).max(2048).optional(),
});

/** Explicit single-task operations; never discovers or executes missing business work. */
export async function goalReviewCommand(action: string, indexPath: string, input?: unknown) {
    const path = await realpath(indexPath);
    if (!/[\\/]index\.md$/.test(path) || !/[\\/]tasks[\\/]/.test(path)) throw new Error('Choose the authoritative task index.md');
    const directory = dirname(path);
    const bytes = await readBoundedFile(directory, path, 256 * 1024);
    const source = bytes.toString('utf8');
    const delivery = readGoalDeliveryAgreement(source);
    const review = readGoalReview(source);
    if (action === 'inspect') {
        const outputs = await Promise.all((delivery?.finalOutputs ?? []).map(async output => {
            if (/^https?:\/\//i.test(output.target)) return { ...output, available: true, versionBound: false };
            try {
                const target = await safePath(directory, join(directory, output.target));
                const info = await stat(target);
                return { ...output, target: relative(directory, target).replace(/\\/g, '/'), available: info.isFile(), revision: info.isFile() ? goalFileRevision(info) : undefined };
            } catch { return { ...output, available: false }; }
        }));
        return { indexPath: path, hash: hash(bytes), status: readGoalTaskStatus(source), delivery, review, outputs };
    }
    if (action !== 'apply') throw new Error('Use inspect or apply');
    const data = patchSchema.parse(input);
    if (data.expectedHash !== hash(bytes)) throw new Error('Task changed; inspect it again');
    if (data.undo && (data.statusChange || data.review || data.delivery)) throw new Error('Undo must be a separate operation');
    let content = source;
    if (data.delivery) content = writeGoalDeliveryAgreement(content, data.delivery);
    if (data.review) {
        if ('statusChanges' in data.review) throw new Error('Use statusChange or undo to preserve the audit history');
        if (Array.isArray(data.review.recognitions) && data.review.recognitions.some(record => /^https?:\/\//i.test(String(record?.target)))) throw new Error('Remote content version is unknown; historical recognition requires a local versioned output');
        content = writeGoalReview(content, GoalReviewSchema.parse({ ...(review ?? emptyGoalReview()), ...data.review, statusChanges: review?.statusChanges ?? [] }));
    }
    if (data.statusChange) content = changeGoalTaskStatus(content, data.statusChange.to, { id: randomUUID(), at: Date.now(), actor: 'ai', reason: data.statusChange.reason, evidence: data.statusChange.evidence });
    if (data.undo) content = undoGoalTaskStatus(content, data.undo, Date.now());
    const saved = await createWorkspaceFileHandlers(directory).write({ path, content: Buffer.from(content).toString('base64'), expectedHash: data.expectedHash });
    if (!saved.success) throw new Error(saved.error ?? 'Could not save task review');
    return { success: true, hash: saved.hash, status: readGoalTaskStatus(content), review: readGoalReview(content) };
}
export async function runGoalReviewCommand(args: string[]) {
    const [action, path, inputPath] = args;
    if (!action || !path || (action === 'apply' && !inputPath)) throw new Error('Usage: paws goal-review inspect <task/index.md> | apply <task/index.md> <patch.json>');
    const input = inputPath ? JSON.parse((await readFile(inputPath)).toString('utf8')) : undefined;
    process.stdout.write(JSON.stringify(await goalReviewCommand(action, path, input), null, 2) + '\n');
}
