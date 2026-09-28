import { expect, it } from 'vitest';
import { firstAgentTextIds } from './turnAvatars';

it('marks one Paws identity per chronological turn without marking tool rows', () => {
    const items = [
        { type: 'message', message: { id: 'answer-2', kind: 'agent-text' } },
        { type: 'tool-group' },
        { type: 'message', message: { id: 'answer-1', kind: 'agent-text' } },
        { type: 'message', message: { id: 'prompt-2', kind: 'user-text' } },
        { type: 'message', message: { id: 'answer-0', kind: 'agent-text' } },
        { type: 'message', message: { id: 'prompt-1', kind: 'user-text' } },
    ];
    expect([...firstAgentTextIds(items)]).toEqual(['answer-0', 'answer-1']);
});
