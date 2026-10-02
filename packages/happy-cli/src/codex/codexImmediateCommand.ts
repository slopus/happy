import { randomUUID } from 'node:crypto';
import { createEnvelope, type SessionEnvelope } from '@slopus/happy-wire';

/** Local commands complete their own Paws turn without changing Codex native state. */
export function immediateCodexCommandEnvelopes(text: string): SessionEnvelope[] {
    const turn = `codex-command-${randomUUID()}`;
    return [
        createEnvelope('agent', { t: 'turn-start' }, { turn }),
        createEnvelope('agent', { t: 'text', text }, { turn }),
        createEnvelope('agent', { t: 'turn-end', status: 'completed' }, { turn }),
    ];
}
