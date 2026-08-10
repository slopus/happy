import { describe, expect, it } from 'vitest';

import { resolveCustomProjectPathSelection, resolveDockAgentType } from './homeDockInteraction';

describe('HomeDock interaction lifecycle', () => {
    it('ignores a custom-project prompt result after HomeDock unmounts', () => {
        expect(resolveCustomProjectPathSelection('~/project', false)).toBeNull();
    });

    it('trims a mounted custom-project prompt result', () => {
        expect(resolveCustomProjectPathSelection('  ~/project  ', true)).toBe('~/project');
        expect(resolveCustomProjectPathSelection('   ', true)).toBeNull();
    });
});

describe('resolveDockAgentType', () => {
    const base = {
        agentType: 'rig',
        rigAgentType: 'rig',
        machineSelected: true,
        rigConnectedHere: false,
        fallbackAgentType: 'claude',
    } as const;

    it('gives up the Rig agent when the chosen machine has no Rig', () => {
        expect(resolveDockAgentType(base)).toBe('claude');
    });

    it('keeps Rig on a machine that runs it', () => {
        expect(resolveDockAgentType({ ...base, rigConnectedHere: true })).toBe('rig');
    });

    it('leaves a saved Rig choice alone until a machine is selected', () => {
        expect(resolveDockAgentType({ ...base, machineSelected: false })).toBe('rig');
    });

    it('keeps Rig when the machine offers no other agent to fall back to', () => {
        expect(resolveDockAgentType({ ...base, fallbackAgentType: undefined })).toBe('rig');
    });

    it('never touches a non-Rig agent', () => {
        expect(resolveDockAgentType({ ...base, agentType: 'codex' })).toBe('codex');
    });
});
