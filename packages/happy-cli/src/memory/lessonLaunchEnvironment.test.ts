import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

import { applyLessonLaunchEnvironment, lessonCallerSharesIdentity } from './lessonLaunchEnvironment';
import { LESSON_OWNER_ENV, LESSON_HOST_DISABLED_ENV } from './lessonOwnerMarker';
import { LESSON_DAEMON_HOME_ENV } from './lessonSessionHost';
import { prepareMcpChildEnvironment } from '@/daemon/mcpCallerGrantEnvelope';

function jwt(payload: Record<string, unknown>): string {
    const encode = (value: Record<string, unknown>) =>
        Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${encode({ alg: 'none' })}.${encode(payload)}.sig`;
}

/** An installed package that states the capability the marker needs. */
const load = async () => ({
    ok: true as const,
    modules: { LESSON_HOST_CAPABILITIES: { version: 1, nativeLessonOwnerMarker: true } } as never,
});

const base = {
    load,
    daemonToken: jwt({ sub: 'account-a' }),
    daemonHomeDir: '/daemon/home',
    projectId: 'p1',
    eligible: true,
};

describe('lessonCallerSharesIdentity', () => {
    it('is the same account through a re-issued token, and a relocated home is not a new account', () => {
        expect(lessonCallerSharesIdentity(jwt({ sub: 'account-a', iat: 2 }), base.daemonToken)).toBe(true);
        expect(lessonCallerSharesIdentity(undefined, base.daemonToken)).toBe(true);
    });

    it('is a different account for a collaborator credential', () => {
        expect(lessonCallerSharesIdentity(jwt({ sub: 'account-b' }), base.daemonToken)).toBe(false);
    });
});

describe('applyLessonLaunchEnvironment', () => {
    it.each([false, true])('applies daemon lesson eligibility without an RPC machineId (Windows trial=%s)', async trial => {
        // Execute the real spawn binding and eligibility expression without
        // starting a daemon or importing its CLI side effects.
        const source = readFileSync(new URL('../daemon/run.ts', import.meta.url), 'utf8');
        const parsed = ts.createSourceFile('run.ts', source, ts.ScriptTarget.Latest, true);
        let spawn: ts.ArrowFunction | undefined;
        const findSpawn = (node: ts.Node) => {
            if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'spawnSession'
                && node.initializer && ts.isArrowFunction(node.initializer)) spawn = node.initializer;
            ts.forEachChild(node, findSpawn);
        };
        findSpawn(parsed);
        let binding = '';
        let eligibility = '';
        const findInputs = (node: ts.Node) => {
            if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)
                && node.initializer?.getText(parsed) === 'options') binding = node.getText(parsed);
            if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'lessonLaunch'
                && node.initializer && ts.isAwaitExpression(node.initializer)
                && ts.isCallExpression(node.initializer.expression)) {
                const argument = node.initializer.expression.arguments[0];
                if (ts.isObjectLiteralExpression(argument)) {
                    const property = argument.properties.find((item) =>
                        ts.isPropertyAssignment(item) && item.name.getText(parsed) === 'eligible');
                    if (property && ts.isPropertyAssignment(property)) eligibility = property.initializer.getText(parsed);
                }
            }
            ts.forEachChild(node, findInputs);
        };
        expect(spawn).toBeDefined();
        findInputs(spawn!);
        expect(binding).not.toBe('');
        expect(eligibility).not.toBe('');
        const eligible = new Function('machineId', 'options', 'managedIdentity', 'lessonStudioOrigin', 'standaloneWindows',
            `return (() => { const ${binding}; return ${eligibility}; })();`
        )('daemon-machine', { directory: '/workspace' }, { status: 'inactive' }, 'https://studio.example', trial ? {} : undefined);
        const loadPackage = vi.fn(load);
        const hostIsReady = vi.fn(async () => false);
        const { decision } = await applyLessonLaunchEnvironment({
            ...base, load: loadPackage, environment: {}, callerToken: base.daemonToken, eligible, hasSessionAuthority: true,
            hostIsReady,
        });
        expect(decision).toEqual(trial
            ? { owner: 'native', reason: 'host-unavailable' }
            : { owner: 'host', reason: 'host-not-ready' });
        expect(loadPackage).toHaveBeenCalledTimes(trial ? 0 : 1);
        expect(hostIsReady).not.toHaveBeenCalled();
    });

    it('keeps a verified session caller behind the host gate before session registration', async () => {
        const hostIsReady = vi.fn(async () => false);
        const { decision } = await applyLessonLaunchEnvironment({
            ...base, environment: {}, callerToken: jwt({ sub: 'account-a' }),
            hasSessionAuthority: true, hostIsReady,
        });
        expect(decision).toEqual({ owner: 'host', reason: 'host-not-ready' });
        expect(hostIsReady).not.toHaveBeenCalled();
    });

    it('claims for a launch whose child asks as the account the proof was taken with', async () => {
        const { environment, decision } = await applyLessonLaunchEnvironment({
            ...base,
            environment: { KEEP: '1', [LESSON_HOST_DISABLED_ENV]: 'unsupported-caller' },
            callerToken: jwt({ sub: 'account-a', iat: 9 }),
            hostIsReady: async () => true,
        });
        expect(decision.owner).toBe('host');
        expect(environment).toEqual({
            KEEP: '1',
            [LESSON_DAEMON_HOME_ENV]: '/daemon/home',
            [LESSON_OWNER_ENV]: 'host',
            [LESSON_HOST_DISABLED_ENV]: '',
        });
    });

    it('disables both injectors for an unsupported collaborator', async () => {
        const hostIsReady = vi.fn(async () => true);
        const { environment, decision } = await applyLessonLaunchEnvironment({
            ...base,
            environment: {},
            callerToken: jwt({ sub: 'account-b' }),
            hasSessionAuthority: true,
            hostIsReady,
        });
        expect(decision).toEqual({ owner: 'disabled', reason: 'unsupported-caller' });
        expect(environment[LESSON_OWNER_ENV]).toBe('host');
        expect(environment[LESSON_HOST_DISABLED_ENV]).toBe('unsupported-caller');
        // Not even asked: the answer would not be about this child.
        expect(hostIsReady).not.toHaveBeenCalled();
    });

    it('overrides a host marker inherited from the daemon\'s own environment', async () => {
        const { environment } = await applyLessonLaunchEnvironment({
            ...base,
            environment: { [LESSON_OWNER_ENV]: 'host' },
            callerToken: jwt({ sub: 'account-b' }),
            hostIsReady: async () => true,
        });
        expect(environment[LESSON_OWNER_ENV]).toBe('host');
        expect(environment[LESSON_HOST_DISABLED_ENV]).toBe('unsupported-caller');
    });

    it('stays native without a trusted project binding', async () => {
        const hostIsReady = vi.fn(async () => true);
        const { decision } = await applyLessonLaunchEnvironment({
            ...base,
            projectId: null,
            environment: {},
            callerToken: null,
            hostIsReady,
        });
        expect(decision.owner).toBe('native');
        expect(hostIsReady).not.toHaveBeenCalled();
    });

    it('restores what the caller sanitizer had to strip', async () => {
        /*
         * The resume path's defect in one test. The sanitizer removes every
         * `HAPPY_LESSON_`/`CLAUDE_MEMORY_` key so a caller cannot forge them,
         * which also removes the daemon's own — and a resumed session that
         * went to the provider like that had no state root and no stated
         * owner.
         */
        const prepared = prepareMcpChildEnvironment({
            environmentVariables: {
                [LESSON_DAEMON_HOME_ENV]: '/attacker/home',
                [LESSON_OWNER_ENV]: 'host',
                KEEP: '1',
            },
        }, { consume: () => ({ ok: true as const, grant: 'g' }) });
        const sanitized = prepared.ok ? prepared.environmentVariables : {};
        expect(sanitized[LESSON_DAEMON_HOME_ENV]).toBeUndefined();

        const { environment } = await applyLessonLaunchEnvironment({
            ...base,
            environment: sanitized as Record<string, string>,
            callerToken: base.daemonToken,
            hostIsReady: async () => true,
        });
        expect(environment[LESSON_DAEMON_HOME_ENV]).toBe('/daemon/home');
        expect(environment[LESSON_OWNER_ENV]).toBe('host');
        expect(environment.KEEP).toBe('1');
    });
});
