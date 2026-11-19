import assert from 'node:assert/strict';
import { agentManagerActor } from './verify.ego.mjs';
/** Execute on the already-owned Ego Page. Caller supplies runtime, never auth. */
export async function verifyCycle(page, runtime) {
    const a = agentManagerActor(page, runtime);
    await a.openModes();
    const states = [];
    for (let step = 0; step < 4; step++) {
        states.push(await page.evaluate(() => {
            const button = document.querySelector('[data-testid="session-composer-agent-cycle"]');
            return { text: document.querySelector('[data-testid="session-composer-open-models"]')?.textContent, svg: button?.querySelector('svg')?.innerHTML };
        }));
        if (step < 3) await page.click('[data-testid="session-composer-agent-cycle"]');
    }
    assert(states[0].text.includes('Codex'));
    assert(states[1].text.includes('Claude'));
    assert(states[2].text.includes('OpenCode'));
    assert.equal(states[0].text, states[3].text);
    assert(states.every(state => state.svg));
    assert.equal(new Set(states.slice(0, 3).map(state => state.svg)).size, 3);
    assert(states.every(state => state.text.includes('Cloud E2E Shared Model')));
    return states.map(({ text }) => text);
}
export async function verifyPreferences(page, runtime) {
    const a = agentManagerActor(page, runtime);
    const machineId = await a.settings('A');
    await a.toggle('claude', true); await a.toggle('opencode', true);
    return { machineId, enabled: await Promise.all(['codex', 'claude', 'opencode'].map(id => a.checked(id))) };
}
