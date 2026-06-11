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

type SessionControl =
    | {
        kind: 'resume';
        claudeSessionId: string;
        startIndex: number;
        endIndex: number;
    }
    | {
        kind: 'session-id';
        claudeSessionId: string;
        startIndex: number;
        endIndex: number;
    }
    | {
        kind: 'continue';
        startIndex: number;
        endIndex: number;
    };

function unsupported(error: string): ResolveResult {
    return { error, mode: 'unsupported' };
}

function missingSessionIdError(flag: string): ResolveResult {
    return unsupported(`Claude session control flag ${flag} requires a session id.`);
}

export function resolveInteractiveClaudeIdentity(input: ResolveInput): ResolveResult {
    const args = [...(input.claudeArgs ?? [])];
    const generateId = input.generateId ?? randomUUID;
    const findLastSession = input.findLastSession ?? claudeFindLastSession;
    const sessionControls: SessionControl[] = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--resume' || arg === '-r') {
            const claudeSessionId = args[i + 1];
            if (!claudeSessionId || claudeSessionId.startsWith('-')) {
                return missingSessionIdError(arg);
            }
            sessionControls.push({
                kind: 'resume',
                claudeSessionId,
                startIndex: i,
                endIndex: i + 2,
            });
            i++;
            continue;
        }
        if (arg.startsWith('--resume=')) {
            const claudeSessionId = arg.slice('--resume='.length);
            if (claudeSessionId.length === 0) {
                return missingSessionIdError('--resume');
            }
            sessionControls.push({
                kind: 'resume',
                claudeSessionId,
                startIndex: i,
                endIndex: i + 1,
            });
            continue;
        }
        if (arg === '--continue' || arg === '-c') {
            sessionControls.push({
                kind: 'continue',
                startIndex: i,
                endIndex: i + 1,
            });
            continue;
        }
        if (arg === '--session-id') {
            const claudeSessionId = args[i + 1];
            if (!claudeSessionId || claudeSessionId.startsWith('-')) {
                return missingSessionIdError(arg);
            }
            sessionControls.push({
                kind: 'session-id',
                claudeSessionId,
                startIndex: i,
                endIndex: i + 2,
            });
            i++;
            continue;
        }
        if (arg.startsWith('--session-id=')) {
            const claudeSessionId = arg.slice('--session-id='.length);
            if (claudeSessionId.length === 0) {
                return missingSessionIdError('--session-id');
            }
            sessionControls.push({
                kind: 'session-id',
                claudeSessionId,
                startIndex: i,
                endIndex: i + 1,
            });
        }
    }

    if (sessionControls.length > 1) {
        return unsupported('Claude interactive remote received conflicting session control flags.');
    }

    const sessionControl = sessionControls[0];
    if (sessionControl) {
        const consumedArgs = args.filter((_, index) => index < sessionControl.startIndex || index >= sessionControl.endIndex);
        if (sessionControl.kind === 'resume') {
            return {
                claudeSessionId: sessionControl.claudeSessionId,
                launchArgs: ['--resume', sessionControl.claudeSessionId, ...consumedArgs],
                consumedArgs,
                mode: 'resume',
            };
        }
        if (sessionControl.kind === 'continue') {
            const claudeSessionId = findLastSession(input.workingDirectory);
            if (!claudeSessionId) {
                return unsupported('No local Claude session found for --continue.');
            }
            return {
                claudeSessionId,
                launchArgs: ['--resume', claudeSessionId, ...consumedArgs],
                consumedArgs,
                mode: 'continue',
            };
        }
        if (sessionControl.kind === 'session-id') {
            return {
                claudeSessionId: sessionControl.claudeSessionId,
                launchArgs: ['--session-id', sessionControl.claudeSessionId, ...consumedArgs],
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
