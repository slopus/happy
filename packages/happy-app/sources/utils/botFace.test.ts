import { describe, expect, it } from 'vitest';

import {
    BOT_FACE_PAINT_SIZE,
    botFaceCredit,
    botFaceSvg,
    inlineUseElements,
    rollBotFaceSeeds,
} from './botFace';

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

describe('a face that needs no reference followed', () => {
    // The canary. inlineUseElements hands back anything it does not recognise,
    // so if DiceBear ever changes the shape it writes, faces would quietly go
    // back to being flat colours on Skia and nothing else would complain. A
    // leftover `<use>` here is that change, caught at build time.
    it('hands the renderer shapes, not pointers at shapes', () => {
        for (const seed of ['abc12345', 'zz990011', 'q7r4t2y8', ...rollBotFaceSeeds()]) {
            const svg = botFaceSvg(seed, BOT_FACE_PAINT_SIZE);
            expect(svg).not.toContain('<use');
            expect(svg).not.toContain('<g id=');
        }
    });

    it('draws a face rather than only the ground it sits on', () => {
        const svg = botFaceSvg('abc12345', BOT_FACE_PAINT_SIZE);
        // The ground is the one <rect>. Skia used to draw that and nothing else,
        // because every feature hid behind a <use> it would not follow.
        expect(svg).toContain('<rect');
        expect(svg.match(/<path\b/g) ?? []).not.toHaveLength(0);
        expect((svg.match(/<path\b/g) ?? []).length).toBeGreaterThanOrEqual(3);
    });

    it('keeps a feature under the transform its reference carried', () => {
        const referenced = '<svg><defs><g id="eye"><path d="M0 0"/></g></defs>'
            + '<g><rect/><use transform="translate(3 4)" href="#eye"/></g></svg>';
        expect(inlineUseElements(referenced)).toBe(
            '<svg><g><rect/><g transform="translate(3 4)"><path d="M0 0"/></g></g></svg>',
        );
    });

    it('resolves a definition that itself contains groups', () => {
        const nested = '<svg><defs><g id="a"><g><path d="M1 1"/></g></g></defs><use href="#a"/></svg>';
        expect(inlineUseElements(nested)).toBe('<svg><g><g><path d="M1 1"/></g></g></svg>');
    });

    it('keeps a definition nothing spent, and drops the block only when bare', () => {
        const spare = '<svg><defs><g id="a"><path/></g><g id="b"><rect/></g></defs><use href="#a"/></svg>';
        expect(inlineUseElements(spare)).toBe('<svg><defs><g id="b"><rect/></g></defs><g><path/></g></svg>');
    });
});

/*
 * Everything below is markup we do not claim to understand. The transform is a
 * compatibility shim for DiceBear's output, so on anything else it has one job:
 * change nothing. Each case here silently drew the wrong face, or no face, in an
 * earlier draft of this code.
 */
describe('markup the face transform refuses to touch', () => {
    const unchanged = (svg: string) => expect(inlineUseElements(svg)).toBe(svg);

    it('never eats a group that is part of the picture', () => {
        unchanged('<svg><g id="visible"><path/></g></svg>');
    });

    it('leaves a group with an id alone even beside a real definition', () => {
        unchanged('<svg><defs><g id="a"><path/></g></defs><g id="visible"><rect/></g></svg>');
    });

    it('refuses the older xlink spelling rather than mangling it', () => {
        unchanged('<svg><defs><g id="p"><path/></g></defs><use xlink:href="#p"/></svg>');
    });

    it('refuses an attribute that merely ends in href', () => {
        unchanged('<svg><defs><g id="p"><path/></g></defs><use data-href="#p" href="#p"/></svg>');
    });

    it('refuses x and y, which shift a use but mean nothing on a group', () => {
        unchanged('<svg><defs><g id="p"><path/></g></defs><use x="10" y="20" href="#p"/></svg>');
    });

    it('refuses a reference nested inside a definition', () => {
        unchanged('<svg><defs><g id="a"><use href="#b"/></g><g id="b"><path/></g></defs><use href="#a"/></svg>');
    });

    it('refuses a paired use it cannot read', () => {
        unchanged('<svg><defs><g id="a"><path/></g></defs><use href="#a"></use></svg>');
    });

    it('refuses a reference to something that is not a group', () => {
        unchanged('<svg><defs><path id="p"/></defs><use href="#p"/></svg>');
    });

    it('refuses a reference it cannot resolve at all', () => {
        unchanged('<svg><defs><g id="a"><path/></g></defs><use href="#missing"/></svg>');
    });

    it('refuses two definitions sharing one name', () => {
        unchanged('<svg><defs><g id="a"><path/></g><g id="a"><rect/></g></defs><use href="#a"/></svg>');
    });

    it('refuses markup with no definitions block', () => {
        unchanged('<svg><use href="#a"/></svg>');
    });
});
