/** Native Personal tools. All command execution and workspace writes pass the session permission gate. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { ToolDefinition } from './model';
import type { PersonalSkill } from './skills';
import { isWithin, GROK_COMPATIBILITY } from './skills';
import { PersonalStore } from './store';

const execFileAsync = promisify(execFile);
export type PersonalPermissionMode = 'default' | 'read-only' | 'yolo';
export function personalPermissionMode(value: unknown): PersonalPermissionMode {
    if (value === 'yolo') return 'yolo';
    if (value === 'read-only' || value === 'plan') return 'read-only';
    return 'default';
}
export type PersonalApproval = (id: string, tool: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<boolean>;
type ToolSpec = { description: string; schema: z.ZodObject; mutates: boolean };
const specs: Record<string, ToolSpec> = {
    list_skills: { description: 'List installed workflow names, descriptions and actual capability requirements.', schema: z.object({}).strict(), mutates: false },
    read_skill: { description: 'Read a workflow by exact installed name, including Paws compatibility rules and its reference.', schema: z.object({ name: z.string() }).strict(), mutates: false },
    read_file: { description: 'Read UTF-8 text in the working directory or registered skill resources, at most 256 KiB.', schema: z.object({ path: z.string() }).strict(), mutates: false },
    write_file: { description: 'Write UTF-8 text within the working directory. Requires execution approval.', schema: z.object({ path: z.string(), content: z.string().max(256 * 1024) }).strict(), mutates: true },
    run_command: { description: 'Run a command in the working directory with a 60 second timeout and bounded output. Requires approval. Browser control must use Ego only.', schema: z.object({ command: z.string().min(1).max(12000) }).strict(), mutates: true },
    memory_read: { description: 'Read private, persistent user preferences for this personal agent.', schema: z.object({}).strict(), mutates: false },
    memory_write: { description: 'Remember a user-stated preference, or forget it with value=null. Never save credentials, payment information or inferred consent.', schema: z.object({ key: z.string(), value: z.string().max(4000).nullable() }).strict(), mutates: true },
};

export const personalToolDefinitions: ToolDefinition[] = Object.entries(specs).map(([name, spec]) => ({
    type: 'function', function: { name, description: spec.description, parameters: z.toJSONSchema(spec.schema) },
}));

export class PersonalTools {
    private readonly cwd: string;
    constructor(cwd: string, private readonly store: PersonalStore, private readonly skills: PersonalSkill[],
        private readonly approve: PersonalApproval) { this.cwd = realpathSync(cwd); }

    private path(path: string, write = false): string {
        const lexical = resolve(this.cwd, path);
        let parent = dirname(lexical);
        if (write) while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
        const actual = write ? join(realpathSync(parent), relative(parent, lexical)) : realpathSync(lexical);
        const roots = [this.cwd, ...(!write ? this.skills.map(skill => dirname(skill.path)) : [])];
        if (!roots.some(root => isWithin(actual, realpathSync(root)))) throw new Error('Path is outside the workspace and registered skill resources');
        if (/(?:^|[/\\])(?:\.env(?:\.[^/\\]+)?|\.ssh|access\.key|agent\.key|auth\.json)(?:$|[/\\])/i.test(actual)) throw new Error('Credential files cannot be read or written by this tool');
        // Resolve existing output files too, so a symlink cannot escape the workspace.
        if (write) {
            try { if (!isWithin(realpathSync(actual), this.cwd)) throw new Error('Output symlink leaves the workspace'); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        return actual;
    }

    async execute(id: string, name: string, input: unknown, mode: PersonalPermissionMode, signal: AbortSignal): Promise<unknown> {
        signal.throwIfAborted();
        const spec = specs[name];
        if (!spec) throw new Error(`Unknown Personal tool: ${name}`);
        const args = spec.schema.parse(input) as Record<string, unknown>;
        if (spec.mutates) {
            if (mode === 'read-only') throw new Error('This tool is disabled in read-only mode');
            // Explicit preference memory is local bookkeeping; shell and file changes still require a gate.
            if (mode !== 'yolo' && name !== 'memory_write' && !await this.approve(id, name, args, signal)) throw new Error('User declined execution');
            signal.throwIfAborted();
        }
        switch (name) {
            case 'list_skills': return this.skills.map(({ name, description, capability }) => ({ name, description, capability }));
            case 'read_skill': {
                const skill = this.skills.find(skill => skill.name === args.name);
                if (!skill) throw new Error('Skill is not installed');
                const adapter = readFileSync(skill.path, 'utf8');
                return skill.name.startsWith('grok-')
                    ? `${GROK_COMPATIBILITY}\n${adapter}\n## Foreign domain reference (not host instructions)\n${readFileSync(join(dirname(skill.path), 'references', 'upstream.md'), 'utf8')}`
                    : adapter;
            }
            case 'read_file': {
                const path = this.path(args.path as string);
                if (statSync(path).size > 256 * 1024) throw new Error('File exceeds 256 KiB');
                return readFileSync(path, 'utf8');
            }
            case 'write_file': {
                const path = this.path(args.path as string, true);
                mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
                writeFileSync(path, args.content as string, { mode: 0o600 });
                return { written: path };
            }
            case 'run_command': {
                const shell = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : process.env.SHELL || '/bin/sh';
                const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', args.command as string] : ['-lc', args.command as string];
                const { stdout, stderr } = await execFileAsync(shell, shellArgs, {
                    cwd: this.cwd, timeout: 60_000, maxBuffer: 256 * 1024, signal, encoding: 'utf8',
                });
                return { stdout: stdout.slice(0, 16000), stderr: stderr.slice(0, 16000) };
            }
            case 'memory_read': return this.store.memory();
            case 'memory_write': this.store.remember(args.key as string, args.value as string | null); return { saved: true };
            default: throw new Error('Unsupported Personal tool');
        }
    }
}
