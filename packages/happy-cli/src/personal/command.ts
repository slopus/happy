/** CLI entry for installing skills, inspecting capabilities, a local turn, or an encrypted Paws session. */
import { randomUUID } from 'node:crypto';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { loadPersonalConfig, personalHome } from './config';
import { importGrokSkills, listPersonalSkills } from './skills';
import { PersonalEngine } from './engine';
import { runPersonal } from './runPersonal';
import { personalPermissionMode } from './tools';

export async function handlePersonalCommand(args: string[]): Promise<void> {
    if (args.includes('--help') || args.includes('-h')) {
        console.log(`Paws Personal — native personal agent\n\npaws personal\npaws personal install-skills <grok-bot-skills.zip>\npaws personal skills\npaws personal --print <prompt> [--permission-mode read-only|default|yolo]\n\nConfigure ~/.happy/personal-agent/config.json with baseUrl, model and optional apiKeyEnv,\nor PAWS_PERSONAL_BASE_URL, PAWS_PERSONAL_MODEL and PAWS_PERSONAL_API_KEY.\nPersonal never requires Codex, Claude, OpenCode or OpenClaw.\n`);
        return;
    }
    const home = personalHome();
    if (args[0] === 'install-skills') {
        if (args.length !== 2) throw new Error('Usage: paws personal install-skills <archive.zip>');
        console.log(JSON.stringify(importGrokSkills(args[1], home), null, 2));
        return;
    }
    if (args[0] === 'skills') {
        console.log(JSON.stringify(listPersonalSkills(home, process.cwd()), null, 2));
        return;
    }
    const value = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
    if (args.includes('--print')) {
        const text = value('--print');
        if (!text) throw new Error('--print requires a prompt');
        const engine = new PersonalEngine({ home, cwd: process.cwd(), sessionId: `local-${randomUUID()}`,
            config: loadPersonalConfig(), approve: async () => false });
        await engine.turn(text, personalPermissionMode(value('--permission-mode')), new AbortController().signal,
            event => { if (event.type === 'text') console.log(event.text); });
        return;
    }
    const { credentials } = await authAndSetupMachineIfNeeded();
    await runPersonal({ credentials, resume: value('--resume'), startedBy: value('--started-by') === 'daemon' ? 'daemon' : 'terminal' });
    // Only the executable exits here. SDK/live checks can await runPersonal
    // without terminating their host; the CLI must release imported handles.
    process.exit(0);
}
