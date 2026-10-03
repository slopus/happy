import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';
import { CheckpointRestorePlanner, type CheckpointRestorePlanRequest } from './checkpointRestorePlan';
import { checkpointCoverageMatcher, checkpointExclusionMatcher } from './checkpointCoverage';
import { resolveCheckpointStoreLayout } from './checkpointStore';

const MAX_BYTES = 1024 * 1024;
const MAX_DIFF_BYTES = 2 * MAX_BYTES;
const OPERAND_PREFIX = 'diff-';
/** A comparison runs a few bounded git calls; an operand this old belongs to a daemon that died mid-diff. */
const STALE_OPERAND_MS = 3600_000;
type FileDiff = { status: 'text' | 'binary' | 'too-large'; diff: string };

/** Read-only, current -> selected checkpoint. The planner owns binding and exclusion checks. */
export async function checkpointFileDiff(checkpointRoot: string, request: CheckpointRestorePlanRequest & { path: string }): Promise<FileDiff> {
    const { path } = request;
    if (path.length > 4096 || /[\\\u0000-\u001F\u007F]/.test(path)
        || path.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
        throw new Error('checkpoint diff path is invalid');
    }
    const projectPath = await realpath(request.projectPath);
    const { plan, details } = await new CheckpointRestorePlanner(checkpointRoot).planWithDetails(request);
    const entry = plan.entries.find(item => item.path === path);
    if (entry?.action === 'conflict' || entry?.reason === 'provenance-unknown'
        || checkpointExclusionMatcher(request)(path)
        || details.some(item => item.path === path && item.detail === 'not-recorded')) {
        throw new Error('checkpoint diff path is unavailable');
    }
    const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...request });
    const env = isolatedEnvironment(layout.gitDirectory);
    const coverage = checkpointCoverageMatcher((await git(['show', '-s', '--format=%b', request.checkpointId], projectPath, env)).toString('utf8'));
    if (coverage?.(path)) throw new Error('checkpoint diff path was not recorded');
    const tree = (await git(['ls-tree', '-z', request.checkpointId, '--', `:(top,literal)${path}`], projectPath, env)).toString('utf8');
    if (!entry && !tree) throw new Error('checkpoint diff path is unavailable');
    let target: Buffer = Buffer.alloc(0);
    let targetMode = '100644';
    if (tree) {
        const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t/.exec(tree);
        if (!match) throw new Error('checkpoint diff target is unsupported');
        targetMode = match[1]!;
        const size = Number((await git(['cat-file', '-s', match[2]], projectPath, env)).toString('utf8'));
        if (!Number.isSafeInteger(size) || size > MAX_BYTES) return { status: 'too-large', diff: '' };
        target = await git(['cat-file', 'blob', match[2]], projectPath, env);
    }
    const source = await currentContents(projectPath, path);
    if (source === null) return { status: 'too-large', diff: '' };
    const current = source.contents;
    const metadata = !source.exists && tree ? `new file mode ${targetMode}\n`
        : source.exists && !tree ? `deleted file mode ${source.mode}\n` : '';
    if (!entry && !current.equals(target)) throw new Error('checkpoint diff file changed while loading');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
        if (current.includes(0) || target.includes(0)) return { status: 'binary', diff: '' };
        decoder.decode(current); decoder.decode(target);
    } catch { return { status: 'binary', diff: '' }; }
    // Temporary comparison operands contain private bytes and are removed even on failure.
    const directory = await mkdtemp(join(layout.gitDirectory, OPERAND_PREFIX));
    try {
        await writeFile(join(directory, 'current'), current, { mode: 0o600 });
        await writeFile(join(directory, 'checkpoint'), target, { mode: 0o600 });
        const output = await git(['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--', 'current', 'checkpoint'], directory, env, true);
        const text = output.toString('utf8');
        // Send file lifecycle metadata and hunks, never machine-local temporary paths.
        const start = text.indexOf('@@ ');
        const diff = metadata + (start < 0 ? '' : text.slice(start));
        return Buffer.byteLength(diff) > MAX_DIFF_BYTES ? { status: 'too-large', diff: '' } : { status: 'text', diff };
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            return { status: 'too-large', diff: '' };
        }
        throw error;
    } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Idle cleanup of private operands a crash left; recent (possibly in-flight) ones and links stay. */
export async function sweepStaleCheckpointDiffOperands(gitDirectory: string): Promise<void> {
    const entries = await readdir(gitDirectory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
    });
    for (const entry of entries) {
        if (!entry.isDirectory() || !/^diff-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
        const path = join(gitDirectory, entry.name);
        const stats = await lstat(path);
        if (stats.isDirectory() && Date.now() - stats.mtimeMs >= STALE_OPERAND_MS) await rm(path, { recursive: true, force: true });
    }
}

async function currentContents(projectPath: string, path: string): Promise<{ contents: Buffer; exists: boolean; mode: string | null } | null> {
    let absolute = projectPath;
    const segments = path.split('/');
    for (let i = 0; i < segments.length; i++) {
        absolute = join(absolute, segments[i]);
        let stats;
        try { stats = await lstat(absolute); }
        catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { contents: Buffer.alloc(0), exists: false, mode: null };
            throw error;
        }
        if (stats.isSymbolicLink() || (i < segments.length - 1 ? !stats.isDirectory() : !stats.isFile())) {
            throw new Error('checkpoint diff refuses unsafe file');
        }
    }
    if (await realpath(absolute) !== absolute) throw new Error('checkpoint diff refuses unsafe path');
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stats = await handle.stat();
        if (!stats.isFile()) throw new Error('checkpoint diff refuses nonregular file');
        if (stats.size > MAX_BYTES) return null;
        const contents = Buffer.alloc(MAX_BYTES + 1);
        let count = 0;
        while (count < contents.length) {
            const { bytesRead } = await handle.read(contents, count, contents.length - count, count);
            if (bytesRead === 0) break;
            count += bytesRead;
        }
        if (await realpath(absolute) !== absolute) throw new Error('checkpoint diff path changed');
        return count > MAX_BYTES ? null : { contents: contents.subarray(0, count), exists: true, mode: stats.mode & 0o111 ? '100755' : '100644' };
    } finally { await handle.close(); }
}

function isolatedEnvironment(gitDirectory: string): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
    return { ...env, GIT_DIR: gitDirectory, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
}
function git(args: string[], cwd: string, env: NodeJS.ProcessEnv, diff = false): Promise<Buffer> {
    return new Promise((resolve, reject) => execFile('git', args,
        { cwd, env, encoding: 'buffer', maxBuffer: MAX_DIFF_BYTES, timeout: 30_000 },
        (error, stdout) => {
            if (error && !(diff && error.code === 1)) reject(error);
            else resolve(stdout);
        }));
}
