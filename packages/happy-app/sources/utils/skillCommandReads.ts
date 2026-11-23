import { extractSkillNamesFromCommand } from '@slopus/happy-wire';
import type { ToolCall } from '@/sync/typesMessage';
import { stringifyToolCommand } from './toolCommand';
import { getEffectiveToolName } from './toolIdentity';

const SHELLS = /^(?:bash|zsh|sh|powershell(?:\.exe)?|pwsh)$/i;
const SHELL_COMMAND_FLAGS = /^(?:-c|-lc|-Command)$/i;
const CONTROL_WORDS = new Set([
    'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'select', 'function',
    'exit', 'return', 'exec', 'set', 'unset', 'alias', 'unalias', 'source', '.', 'eval', 'trap',
    'export', 'readonly', 'declare', 'typeset', 'local', 'enable', 'hash', 'builtin', 'break', 'continue',
]);

/** A conservative lexer for independent shell statements, never a shell evaluator.
 * Quoted text and escaped spaces remain a single argument. Unsupported control
 * flow invalidates the command so examples and skipped branches cannot become Skills.
 */
function independentStatements(source: string): string[][] | null {
    const statements: string[][] = [];
    let tokens: string[] = [];
    let token = '';
    let started = false;
    let quote: "'" | '"' | null = null;
    const endToken = () => {
        if (started) tokens.push(token);
        token = '';
        started = false;
    };
    const endStatement = () => {
        endToken();
        if (tokens.length) statements.push(tokens);
        tokens = [];
    };
    for (let i = 0; i < source.length; i++) {
        const char = source[i];
        if (quote === "'") {
            if (char === "'") quote = null;
            else token += char;
            continue;
        }
        if (quote === '"') {
            if (char === '"') quote = null;
            else if (char === '\\' && /[\\"$`\n]/.test(source[i + 1] ?? '')) {
                const escaped = source[++i];
                if (escaped !== '\n') token += escaped;
            } else token += char;
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
            started = true;
        } else if (char === '\\') {
            if (i + 1 >= source.length) return null;
            const escaped = source[++i];
            if (escaped !== '\n') { token += escaped; started = true; }
        } else if (char === '#' && !started) {
            while (i + 1 < source.length && source[i + 1] !== '\n') i++;
        } else if (char === ';' || char === '\n') {
            endStatement();
        } else if (/\s/.test(char)) {
            endToken();
        } else if (/[|&<>`$(){}]/.test(char)) {
            return null;
        } else {
            token += char;
            started = true;
        }
    }
    if (quote) return null;
    endStatement();
    return statements.some(parts => CONTROL_WORDS.has(parts[0]) || /^[A-Za-z_]\w*=/.test(parts[0])) ? null : statements;
}

function readNames(source: string, depth = 0): string[] {
    if (depth > 2 || /[\u0000\u0008\u000b\u000c]/.test(source)) return [];
    const statements = independentStatements(source);
    if (!statements) return [];
    const wrapper = statements.length === 1 ? statements[0] : undefined;
    if (wrapper?.length === 3 && SHELLS.test(wrapper[0].split('/').pop() ?? '')
        && SHELL_COMMAND_FLAGS.test(wrapper[1])) {
        return readNames(wrapper[2], depth + 1);
    }
    const names = new Set<string>();
    for (const parts of statements) {
        if (parts.some(part => /[\u0000-\u001f\u007f*?\[\]]/.test(part))) continue;
        // Reuse the strict reader/option and plugin-name rules after decoding
        // shell escaping. Ordinary commands remain ordinary terminal operations.
        const [executable, ...args] = parts;
        if (/[\s;|&<>`$(){}"']/.test(executable)) continue;
        const canonical = [executable, ...args.map(part => JSON.stringify(part))].join(' ');
        for (const name of extractSkillNamesFromCommand(canonical)) names.add(name);
    }
    return [...names];
}

/** Additive history activity: the retained command's status is not a per-Skill result. */
export function getSkillCommandNames(tool: Pick<ToolCall, 'name' | 'input'>): string[] {
    if (!['Bash', 'CodexBash', 'execute'].includes(getEffectiveToolName(tool))) return [];
    const command = tool.input?.command ?? tool.input?.CommandLine;
    if (Array.isArray(command)) {
        if (!command.length || !command.every(part => typeof part === 'string')) return [];
        if (SHELLS.test(command[0].split('/').pop() ?? '')) {
            return command.length === 3 && SHELL_COMMAND_FLAGS.test(command[1]) ? readNames(command[2]) : [];
        }
        return readNames([command[0], ...command.slice(1).map(part => JSON.stringify(part))].join(' '));
    }
    const source = stringifyToolCommand(command);
    return source ? readNames(source) : [];
}
