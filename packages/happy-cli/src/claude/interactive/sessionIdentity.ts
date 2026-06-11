import { randomUUID } from 'node:crypto';
import { claudeFindLastSession } from '@/claude/utils/claudeFindLastSession';

type ResolveInput = {
    workingDirectory: string;
    claudeArgs?: string[];
    generateId?: () => string;
    findLastSession?: (workingDirectory: string) => string | null;
};

type ResolveResult =
    | {
        claudeSessionId: string;
        launchArgs: string[];
        consumedArgs: string[];
        mode: 'fresh' | 'resume' | 'continue';
    }
    | {
        error: string;
        mode: 'unsupported';
    };

export function resolveInteractiveClaudeIdentity(input: ResolveInput): ResolveResult {
    const args = [...(input.claudeArgs ?? [])];
    const generateId = input.generateId ?? randomUUID;
    const findLastSession = input.findLastSession ?? claudeFindLastSession;
    const consumedArgs: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if ((arg === '--resume' || arg === '-r') && args[i + 1] && !args[i + 1].startsWith('-')) {
            const claudeSessionId = args[i + 1];
            consumedArgs.push(...args.slice(0, i), ...args.slice(i + 2));
            return {
                claudeSessionId,
                launchArgs: ['--resume', claudeSessionId, ...consumedArgs],
                consumedArgs,
                mode: 'resume',
            };
        }
        if (arg.startsWith('--resume=')) {
            const claudeSessionId = arg.slice('--resume='.length);
            consumedArgs.push(...args.slice(0, i), ...args.slice(i + 1));
            return {
                claudeSessionId,
                launchArgs: ['--resume', claudeSessionId, ...consumedArgs],
                consumedArgs,
                mode: 'resume',
            };
        }
        if (arg === '--continue' || arg === '-c') {
            const claudeSessionId = findLastSession(input.workingDirectory);
            if (!claudeSessionId) {
                return { error: 'No local Claude session found for --continue.', mode: 'unsupported' };
            }
            consumedArgs.push(...args.slice(0, i), ...args.slice(i + 1));
            return {
                claudeSessionId,
                launchArgs: ['--resume', claudeSessionId, ...consumedArgs],
                consumedArgs,
                mode: 'continue',
            };
        }
        if (arg === '--session-id' && args[i + 1] && !args[i + 1].startsWith('-')) {
            const claudeSessionId = args[i + 1];
            consumedArgs.push(...args.slice(0, i), ...args.slice(i + 2));
            return {
                claudeSessionId,
                launchArgs: ['--session-id', claudeSessionId, ...consumedArgs],
                consumedArgs,
                mode: 'fresh',
            };
        }
        if (arg.startsWith('--session-id=')) {
            const claudeSessionId = arg.slice('--session-id='.length);
            consumedArgs.push(...args.slice(0, i), ...args.slice(i + 1));
            return {
                claudeSessionId,
                launchArgs: ['--session-id', claudeSessionId, ...consumedArgs],
                consumedArgs,
                mode: 'fresh',
            };
        }
    }

    const claudeSessionId = generateId();
    return {
        claudeSessionId,
        launchArgs: ['--session-id', claudeSessionId, ...args],
        consumedArgs: args,
        mode: 'fresh',
    };
}
