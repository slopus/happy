import { describe, expect, it } from 'vitest';

import { BOT_FACE_PAINT_SIZE, botFaceCredit, botFaceSvg, rollBotFaceSeeds } from './botFace';

describe('bot faces', () => {
    it('draws the same face for the same seed, and a different one for another', () => {
        expect(botFaceSvg('abc12345', 64)).toBe(botFaceSvg('abc12345', 64));
        expect(botFaceSvg('abc12345', 64)).not.toBe(botFaceSvg('abc12346', 64));
    });

    it('draws only shapes: no comment, no metadata block, at the size asked for', () => {
        const svg = botFaceSvg('abc12345', BOT_FACE_PAINT_SIZE);
        expect(svg.startsWith('<svg ')).toBe(true);
        expect(svg).not.toContain('<!--');
        expect(svg).not.toContain('<metadata');
        expect(svg).toContain(`width="${BOT_FACE_PAINT_SIZE}"`);
        expect(svg).toContain(`height="${BOT_FACE_PAINT_SIZE}"`);
    });

    it('rolls four short seeds a person could read back', () => {
        const seeds = rollBotFaceSeeds();
        expect(seeds).toHaveLength(4);
        for (const seed of seeds) expect(seed).toMatch(/^[a-z0-9]{8}$/);
    });

    it('credits the pack and its artist from the style itself', () => {
        expect(botFaceCredit.pack).toBe('Adventurer Neutral');
        expect(botFaceCredit.artist).toBe('Lisa Wischofsky');
        expect(botFaceCredit.artistUrl).toMatch(/^https:\/\//);
    });
});
