import { describe, expect, it, vi } from 'vitest';
import type { InteractivePreviewEvent } from '@slopus/happy-wire';
import { SessionPreviewSlots } from './sessionPreviewSlots';

function runningPreview(id: string, onStop: (event: InteractivePreviewEvent) => void) {
    const preview: InteractivePreviewEvent = {
        version: 1, id, title: `Preview ${id}`, provider: 'cloudflare', mode: 'tunnel',
        state: 'ready', url: `https://${id}.trycloudflare.com`, publishedAt: 100, expiresAt: 200,
    };
    const stop = vi.fn(() => onStop({ ...preview, state: 'expired', url: undefined, expiresAt: 150 }));
    return { preview, stop };
}

describe('SessionPreviewSlots', () => {
    it('counts active and publishing tunnels, then releases a slot when one is closed', () => {
        const reportExpired = vi.fn();
        const slots = new SessionPreviewSlots(reportExpired);
        const first = runningPreview('first', (event) => slots.expired('first', event));
        slots.add('first', first);
        expect(slots.reserve('second', 'tunnel')).toBe(true);
        expect(slots.reserve('third', 'tunnel')).toBe(true);
        expect(slots.status()).toMatchObject({ limit: 3, used: 3, remaining: 0, publishing: 2, previews: [expect.objectContaining({ id: 'first' })] });
        expect(slots.reserve('fourth', 'tunnel')).toBe(false);

        expect(slots.close('first')).toBe(true);
        expect(first.stop).toHaveBeenCalledOnce();
        expect(reportExpired).toHaveBeenCalledWith(expect.objectContaining({ id: 'first', state: 'expired', url: undefined }));
        expect(slots.status()).toMatchObject({ used: 2, remaining: 1, publishing: 2, previews: [] });
        expect(slots.reserve('fourth', 'tunnel')).toBe(true);
        expect(slots.close('first')).toBe(false);
    });

    it('does not let a hosted publication consume a tunnel slot', () => {
        const slots = new SessionPreviewSlots(vi.fn());
        expect(slots.reserve('hosted', 'hosted')).toBe(true);
        expect(slots.status()).toMatchObject({ used: 0, remaining: 3, publishing: 0 });
        expect(slots.reserve('hosted', 'hosted')).toBe(false);
        slots.finishPublication('hosted');
        expect(slots.hasPublication('hosted')).toBe(false);
    });

    it('shows occupied slots when all three tunnels are still starting', () => {
        const slots = new SessionPreviewSlots(vi.fn());
        for (const id of ['first', 'second', 'third']) expect(slots.reserve(id, 'tunnel')).toBe(true);
        expect(slots.status()).toMatchObject({ used: 3, remaining: 0, publishing: 3, previews: [] });
        expect(slots.reserve('fourth', 'tunnel')).toBe(false);
    });

    it('frees an automatically expired tunnel and stops only its own active previews', () => {
        const slots = new SessionPreviewSlots(vi.fn());
        const first = runningPreview('first', (event) => slots.expired('first', event));
        const second = runningPreview('second', (event) => slots.expired('second', event));
        slots.add('first', first);
        slots.add('second', second);
        slots.expired('first', { ...first.preview, state: 'expired', url: undefined });
        expect(slots.status()).toMatchObject({ used: 1, remaining: 2 });
        slots.stopAll();
        expect(first.stop).not.toHaveBeenCalled();
        expect(second.stop).toHaveBeenCalledOnce();
        expect(slots.status()).toMatchObject({ used: 0, remaining: 3 });
    });
});
