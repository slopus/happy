import { describe, expect, it, vi } from 'vitest';
import { PawsAgentEvents } from './events';

describe('PawsAgentEvents', () => {
    it('keeps delivery isolated and returns an idempotent unsubscribe', () => {
        const logger = { error: vi.fn() };
        const events = new PawsAgentEvents(logger);
        const healthy = vi.fn();
        const unsubscribeBroken = events.subscribe(() => { throw new Error('listener failed'); });
        const unsubscribeHealthy = events.subscribe(healthy);

        events.emit({ type: 'connection', state: 'ready' });
        unsubscribeBroken();
        unsubscribeBroken();
        unsubscribeHealthy();
        events.emit({ type: 'connection', state: 'disconnected' });

        expect(healthy).toHaveBeenCalledOnce();
        expect(logger.error).toHaveBeenCalledWith('Paws Agent event listener failed');
    });
});
