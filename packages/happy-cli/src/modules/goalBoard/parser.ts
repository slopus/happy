import { readdir, stat, lstat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import type { GoalArtifact, GoalArtifactKind, GoalBoardSnapshot, GoalTask, GoalTaskStatus } from '@slopus/happy-wire';
import { safePath, within, type CatalogRecord } from './catalog';
import { openAuthorizedFile } from './authorizedFiles';

const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_NAVIGATION = 24;
const MAX_TASKS = 200;
const MAX_METADATA_BYTES = 192 * 1024;
const statuses = new Set(['pending', 'running', 'review', 'done', 'blocked']);
const clipped = (value: string) => value.trim().slice(0, 2048);
export const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);

/** fstat and bounded reads apply even if the file grows after the initial stat. */
export async function readBoundedFile(root: string, candidate: string, maxBytes: number): Promise<Buffer> {
    const { handle, info } = await openAuthorizedFile(root, candidate, maxBytes);
    try {
        const buffer = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
            const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
            if (!chunk.bytesRead) break;
            bytesRead += chunk.bytesRead;
        }
        if (bytesRead > maxBytes || bytesRead > info.size) throw new Error('File grew while reading');
        return buffer.subarray(0, bytesRead);
    } finally { await handle.close(); }
}
export async function readDocument(root: string, path: string): Promise<string> { return (await readBoundedFile(root, path, MAX_DOCUMENT_BYTES)).toString('utf8'); }
export function titleOf(source: string): string { return clipped(source.match(/^#\s+(.+)$/m)?.[1] || ''); }
function clean(value: string): string { return clipped(value.replace(/^['"]|['"]$/g, '').replace(/\*\*/g, '')); }

type Fields = Record<string, string | string[]>;
function fieldsOf(source: string, warn: (message: string) => void): Fields {
    const result: Fields = {};
    if (source.startsWith('---\n') || source.startsWith('---\r\n')) {
        const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
        if (!match) { warn('Malformed task frontmatter'); return {}; }
        let listKey: string | undefined;
        let malformed = false;
        for (const line of match[1].split(/\r?\n/)) {
            if (!line.trim() || line.trim().startsWith('#')) continue;
            if (/^\s+-\s/.test(line) && listKey) { (result[listKey] as string[]).push(clean(line.replace(/^\s+-\s*/, ''))); continue; }
            const field = line.match(/^([\w\u4e00-\u9fff]+):\s*(.*?)\s*$/);
            if (!field || /[\[\]{}]/.test(field[2])) { warn('Malformed or unsupported task frontmatter'); malformed = true; if (field?.[1] === 'status') result.status = 'unknown'; listKey = undefined; continue; }
            listKey = undefined;
            if (field[2] === '') { result[field[1]] = []; listKey = field[1]; }
            else result[field[1]] = clean(field[2]);
        }
        if (malformed) result.status = 'unknown';
    }
    for (const line of source.replace(/^---\r?\n[\s\S]*?\r?\n---/, '').split(/\r?\n/)) {
        const field = line.match(/^\s*(?:[-*]\s+)?(?:\*\*)?([\w\u4e00-\u9fff]+)(?:\*\*)?\s*[:：]\s*(.+)$/);
        if (field && field[1] !== 'status' && !(field[1] in result)) result[field[1]] = clean(field[2]);
    }
    return result;
}
function scalar(fields: Fields, names: string[]): string | undefined { for (const name of names) if (typeof fields[name] === 'string') return fields[name] as string; return undefined; }
function section(source: string, names: string[]): string | undefined {
    const lines = source.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const heading = lines[i].match(/^(#{1,6})\s+(.+)$/);
        if (!heading || !names.includes(heading[2].trim())) continue;
        let end = i + 1;
        while (end < lines.length && !new RegExp(`^#{1,${heading[1].length}}\\s`).test(lines[end])) end++;
        return clipped(lines.slice(i + 1, end).join('\n')) || undefined;
    }
    return undefined;
}
function items(fields: Fields, names: string[], docs: string[], headings: string[]): string[] {
    for (const name of names) if (fields[name]) return (Array.isArray(fields[name]) ? fields[name] as string[] : [fields[name] as string]).slice(0, 30).map(clipped);
    for (const doc of docs) {
        const value = section(doc, headings);
        if (value) return value.split('\n').map(line => line.replace(/^\s*(?:[-*]|\d+[.)、])\s*/, '').trim()).filter(Boolean).slice(0, 30).map(clipped);
    }
    return [];
}

type Link = { name: string; target: string; description?: string; heading: string; line: string };
function linksOf(source: string): Link[] {
    const result: Link[] = [];
    const headings: string[] = [];
    for (const line of source.split(/\r?\n/)) {
        const h = line.match(/^(#{1,6})\s+(.+)/);
        if (h) { headings.length = h[1].length; headings[h[1].length - 1] = h[2]; }
        const heading = headings.filter(Boolean).join(' / ');
        // Markdown paths may contain Unicode and spaces; optional angle wrapping is supported.
        for (const match of line.matchAll(/(?<!!)\[([^\]]+)\]\((<[^>]+>|[^)]+)\)/g)) {
            const tail = line.slice((match.index || 0) + match[0].length).replace(/^\s*[:：]\s*/, '').trim();
            result.push({ name: clipped(match[1]), target: match[2].replace(/^<|>$/g, '').replace(/\s+"[^"]*"$/, ''), heading, line, description: tail ? clipped(tail) : undefined });
        }
    }
    return result;
}
function localTarget(parent: string, target: string): string | null {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) return null;
    try { return resolve(dirname(parent), decodeURIComponent(target.split('#')[0])); } catch { return null; }
}
export function artifactKind(path: string): GoalArtifactKind {
    const extension = extname(path).toLowerCase();
    if (['.md', '.mdx', '.txt', '.json', '.jsonl', '.yaml', '.yml', '.csv', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.html', '.css', '.py', '.go', '.rs', '.sh', '.sql', '.toml', '.xml', '.log', '.svg'].includes(extension)) return 'text';
    if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.heic'].includes(extension)) return 'image';
    if (['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.flac', '.opus'].includes(extension)) return 'audio';
    if (['.mp4', '.webm', '.mov', '.m4v'].includes(extension)) return 'video';
    if (extension === '.pdf') return 'pdf';
    return 'unsupported';
}
async function authorizedSourceParent(root: string, candidate: string, directories: Set<string>): Promise<string | undefined> {
    if (!within(root, candidate)) return undefined;
    // A broken symlink is not a missing authorized original.
    if ((await lstat(candidate).catch(() => undefined))?.isSymbolicLink()) return undefined;
    let parent = dirname(candidate);
    while (within(root, parent)) {
        try {
            const actual = await safePath(root, parent);
            if (!(await stat(actual)).isDirectory()) return undefined;
            let watched = actual;
            for (let depth = 0; depth < 40 && within(root, watched); depth++) {
                directories.add(watched);
                if (watched === root) break;
                watched = dirname(watched);
            }
            return join(actual, relative(parent, candidate));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || (await lstat(parent).catch(() => undefined))?.isSymbolicLink()) return undefined;
        }
        if (parent === root) break;
        parent = dirname(parent);
    }
    return undefined;
}
async function artifactsOf(root: string, taskPath: string, source: string, directories: Set<string>): Promise<GoalArtifact[]> {
    const artifacts: GoalArtifact[] = [];
    for (const link of linksOf(source)) {
        if (artifacts.length >= 50) break;
        const isContract = /^(PROMPT|AGENTS|problem|PROGRESS)\.md$/i.test(basename(link.target)) || /契约|合同|任务说明|执行依据|历史|参考|基准|计划|预期/.test(link.name) || /历史|参考|输入|契约|计划|预期|\b(?:references?|inputs?|contracts?|historical|baseline|planned|plans?|expected|future|proposals?)\b/i.test(link.heading + ' ' + link.name);
        const explicitOutput = /(?:当前|最终|交付)产物|最终(?:交付|成果)|实际(?:产物|产出|成果|交付)|阶段(?:产物|交付)|已(?:产出|交付|生成)|\b(?:(?:actual|final)\s+(?:outputs?|results?|deliverables?)|produced\s+(?:outputs?|files?|reports?)|outputs?|results?)\b/i.test(link.heading);
        if (/^https?:\/\//i.test(link.target)) {
            artifacts.push({ id: digest(link.target), name: link.name, url: link.target.slice(0, 8192), kind: /\/commit\/[0-9a-f]+/i.test(link.target) ? 'commit' : 'url', relation: !isContract && explicitOutput ? 'output' : 'reference', available: true, description: link.description }); continue;
        }
        const path = localTarget(taskPath, link.target);
        if (!path || basename(path) === 'index.md') continue;
        const id = digest(path);
        if (artifacts.some(a => a.id === id)) continue;
        const relation = !isContract && explicitOutput && within(dirname(taskPath), path) ? 'output' : 'reference';
        const artifact: GoalArtifact = { id, kind: artifactKind(path), name: link.name, relation, available: false, description: link.description };
        try {
            const actual = await safePath(root, path);
            const info = await stat(actual);
            if (info.isFile()) Object.assign(artifact, { path: actual, available: true, size: info.size, modifiedAt: info.mtimeMs });
        } catch {
            const registered = await authorizedSourceParent(root, path, directories);
            if (registered) artifact.path = registered;
        }
        if (artifact.available && artifact.path) await authorizedSourceParent(root, artifact.path, directories);
        artifacts.push(artifact);
    }
    return artifacts;
}

export type ParsedBoard = { snapshot: GoalBoardSnapshot; watchDirectories: string[] };
export async function parseBoard(entry: CatalogRecord): Promise<ParsedBoard> {
    const { root, featurePath } = entry;
    const warnings: string[] = [];
    const warn = (message: string) => { if (warnings.length < 50 && !warnings.includes(message)) warnings.push(clipped(message)); };
    const directories = new Set<string>([featurePath]);
    let bytesRead = 0;
    const load = async (path: string) => {
        if (bytesRead >= 8 * 1024 * 1024) throw new Error('Goal document budget exceeded');
        await authorizedSourceParent(root, path, directories);
        const text = await readDocument(root, path); bytesRead += Buffer.byteLength(text); directories.add(dirname(await safePath(root, path))); return text;
    };
    const featureIndex = join(featurePath, 'index.md');
    const featureText = await load(featureIndex);
    const docs: Array<{ path: string; text: string }> = [{ path: featureIndex, text: featureText }];
    const tasks = new Map<string, { path: string; code?: string; batch?: string }>();
    const addTask = async (path: string, line = '') => {
        if (tasks.size >= MAX_TASKS) { warn('Task limit reached; board is truncated'); return; }
        try {
            // Keep the nearest authorized parent even while the mapped source is missing.
            await authorizedSourceParent(root, path, directories);
            const actual = await safePath(root, path);
            if (!actual.includes('/tasks/') || basename(actual) !== 'index.md') return;
            const code = line.match(/\bG\d{2,}\b/)?.[0];
            const existing = tasks.get(actual);
            if (!existing) tasks.set(actual, { path: actual, code, batch: dirname(dirname(dirname(actual))) !== featurePath ? basename(dirname(dirname(dirname(actual)))) : undefined });
            else if (code && !existing.code) existing.code = code;
        } catch { warn(`Unavailable task entry: ${basename(dirname(path))}`); }
    };
    // Follow only local feature-level Markdown navigation, never task Prompt or arbitrary directory trees.
    for (let i = 0; i < docs.length && i < MAX_NAVIGATION; i++) {
        for (const link of linksOf(docs[i].text)) {
            const path = localTarget(docs[i].path, link.target);
            if (!path) continue;
            if (path.includes('/tasks/') && basename(path) === 'index.md') { await addTask(path, link.line); continue; }
            if (path.includes('/tasks/') || extname(path).toLowerCase() !== '.md' || !within(root, path)) continue;
            const navigationName = basename(path);
            const isNavigation = /^(index|PROMPT|problem)\.md$/i.test(navigationName) || /任务(?:地图|总表|安排|导航|清单)|(?:task|goal)[-_ ]?(?:map|list|index|catalog)/i.test(navigationName) || /任务.*(?:地图|安排|导航|清单|候选|总表)/.test(link.name);
            if (!isNavigation) continue;
            // Ancestor project indices would import unrelated features; only current/sibling feature docs qualify.
            if (!path.includes('/features/') || /历史|旧版|历史上下文/.test(link.name + basename(path))) continue;
            if (docs.some(doc => doc.path === path) || docs.length >= MAX_NAVIGATION) continue;
            try { docs.push({ path, text: await load(path) }); } catch { warn(`Unavailable navigation: ${basename(path)}`); }
        }
    }
    // Portable workspaces may omit a task navigation list; inspect one bounded tasks level.
    try {
        const folder = await safePath(root, join(featurePath, 'tasks'));
        directories.add(folder);
        for (const name of (await readdir(folder)).sort().slice(0, MAX_TASKS)) if (name !== 'templates') await addTask(join(folder, name, 'index.md'));
    } catch { /* Feature may have no tasks. */ }
    const parsed: GoalTask[] = [];
    const allTasks = [...tasks.values()];
    // Explicit G navigation is the current catalog; unlisted legacy task folders are not extra work.
    const mappedTasks = allTasks.filter(task => task.code);
    const seenCodes = new Set<string>();
    const authoritative = mappedTasks.length ? mappedTasks.filter(task => {
        if (seenCodes.has(task.code!)) { warn(`Duplicate global task mapping: ${task.code}`); return false; }
        seenCodes.add(task.code!); return true;
    }) : allTasks;
    const ordered = authoritative.sort((a, b) => (a.code || '\uffff' + a.path).localeCompare(b.code || '\uffff' + b.path));
    for (const task of ordered) {
        try {
            const index = await load(task.path);
            const fields = fieldsOf(index, message => warn(`${basename(dirname(task.path))}: ${message}`));
            const promptPath = await safePath(root, join(dirname(task.path), 'PROMPT.md')).catch(() => undefined);
            const prompt = promptPath ? await load(promptPath).catch(error => { warn(`${basename(dirname(task.path))}: ${error.message}`); return ''; }) : '';
            const promptFields = fieldsOf(prompt, () => {});
            const problemPath = join(dirname(task.path), 'problem.md');
            const problemDoc = await load(problemPath).catch(() => '');
            const code = task.code || index.match(/全局\s*(G\d{2,})/)?.[1];
            const result: GoalTask = {
                id: digest(task.path), code, indexPath: task.path, promptPath,
                title: titleOf(index) || basename(dirname(task.path)),
                status: statuses.has(scalar(fields, ['status']) || '') ? scalar(fields, ['status']) as GoalTaskStatus : 'unknown',
                goal: scalar(fields, ['goal', '目标摘要', '目标']) || section(index, ['目标', '目标摘要']) || scalar(promptFields, ['goal', '目标']) || section(prompt, ['目标', '目标与范围']) || '',
                problem: scalar(fields, ['problem', '问题', '要解决的问题']) || section(index, ['问题', '要解决的问题']) || section(prompt, ['问题', '要解决的问题', '背景与问题']) || section(problemDoc, ['问题', '要解决的问题', '原始问题']),
                stage: scalar(fields, ['stage', '阶段', '当前阶段']) || section(index, ['当前阶段', '阶段']),
                progress: scalar(fields, ['progress', '进度']) || section(index, ['进度', '当前进展']),
                nextStep: scalar(fields, ['nextStep', 'next_step', '下一步']) || section(index, ['下一步']),
                dependencies: items(fields, ['dependencies', '依赖'], [index, prompt], ['依赖', '前置条件', '前置依赖']),
                expectedDeliverables: items(fields, ['expectedDeliverables', 'expected_deliverables', '预期交付物'], [index, prompt], ['预期交付物', '计划交付', '预期产物', '交付物', '交付与验收', '未来交付与验证建议']),
                artifacts: await artifactsOf(root, task.path, index, directories), batch: scalar(fields, ['batch', '批次']) || task.batch,
            };
            for (const artifact of result.artifacts) if (artifact.path) directories.add(dirname(artifact.path));
            if (Buffer.byteLength(JSON.stringify(parsed)) + Buffer.byteLength(JSON.stringify(result)) > MAX_METADATA_BYTES) { warn('Snapshot size limit reached; board is truncated'); break; }
            parsed.push(result);
        } catch (error) { warn(`${basename(dirname(task.path))}: ${error instanceof Error ? error.message : 'Unreadable task'}`); }
    }
    if (directories.size > 400) warn('Watcher directory limit reached; use explicit refresh for unobserved artifact changes');
    const content = { featurePath, title: entry.title, projectTitle: entry.projectTitle, tasks: parsed, warnings };
    return { snapshot: { ...content, revision: digest(JSON.stringify(content)), updatedAt: Date.now() }, watchDirectories: [...directories].slice(0, 400) };
}
