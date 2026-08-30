import { describe, expect, it } from 'vitest';
import type { MachineChoice } from '@/sync/machineChoices';
import type { Session } from '@/sync/storageTypes';
import { buildOfflineMachineTroubleshooting } from './offlineMachineTroubleshooting';

function choice(options: {
    id: string;
    name: string;
    activeAt: number;
    happyHomeDir?: string;
}): MachineChoice {
    return {
        id: options.id,
        name: options.name,
        machineIds: [options.id],
        happyMachine: {
            id: options.id,
            active: false,
            activeAt: options.activeAt,
            metadata: options.happyHomeDir ? { happyHomeDir: options.happyHomeDir } : null,
        } as MachineChoice['happyMachine'],
        rigMachine: null,
        online: false,
        activeAt: options.activeAt,
    };
}

function session(options: {
    machineId: string;
    path: string;
    projectName?: string;
    updatedAt: number;
}): Session {
    return {
        id: `${options.machineId}-${options.updatedAt}`,
        updatedAt: options.updatedAt,
        metadata: {
            machineId: options.machineId,
            path: options.path,
            project: options.projectName
                ? { id: 'project-id', kind: 'project', name: options.projectName }
                : undefined,
        },
    } as Session;
}

describe('offline machine troubleshooting', () => {
    it('points the AI at the Happy folder and names the machine and project', () => {
        const guide = buildOfflineMachineTroubleshooting([
            choice({ id: 'mac', name: 'Kirill’s Mac', activeAt: 10, happyHomeDir: '/Users/kirill/.happy' }),
        ], [
            session({ machineId: 'mac', path: '/Users/kirill/Developer/happy', projectName: 'Happy', updatedAt: 20 }),
        ]);

        expect(guide.aiPrompt).toBe('In /Users/kirill/.happy, diagnose why Happy cannot reach "Kirill’s Mac" for project "Happy".');
        expect(guide.message).toContain('1. Wake the machine and check internet.');
        expect(guide.message.endsWith(guide.aiPrompt)).toBe(true);
    });

    it('uses the newest known project to choose which offline machine to troubleshoot', () => {
        const guide = buildOfflineMachineTroubleshooting([
            choice({ id: 'desktop', name: 'Desktop', activeAt: 100, happyHomeDir: '/desktop/.happy' }),
            choice({ id: 'laptop', name: 'Laptop', activeAt: 50, happyHomeDir: '/laptop/.happy' }),
        ], [
            session({ machineId: 'desktop', path: '/work/older', updatedAt: 20 }),
            session({ machineId: 'laptop', path: 'C:\\work\\current-project', updatedAt: 30 }),
        ]);

        expect(guide.machineName).toBe('Laptop');
        expect(guide.projectName).toBe('current-project');
        expect(guide.happyHomeDir).toBe('/laptop/.happy');
    });

    it('still produces a useful prompt before any session exists', () => {
        const guide = buildOfflineMachineTroubleshooting([
            choice({ id: 'mac', name: 'Mac', activeAt: 10 }),
        ], []);

        expect(guide.projectName).toBe('Happy');
        expect(guide.happyHomeDir).toBe('~/.happy');
    });
});