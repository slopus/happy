import { describe, expect, it } from 'vitest';
import { IMAGE_AGENT_STYLE_PRESETS } from './imageAgentPrompt';
import type { AgentLauncher } from './launchAgent';
import {
    IMAGE_STYLE_COMPOSE_ROUTE,
    createBuiltinImageStyleAgent,
    createImageStyleSelectionPrompt,
    selectImageAgentStyle,
    setImageAgentVariantCount,
    toggleImageAgentStyle,
    resolveComposeImageAgent,
} from './imageAgentMode';

const savedImageAgent: AgentLauncher = {
    id: 'saved-image-agent',
    name: 'Saved image agent',
    glyph: 'S',
    color: '#885533',
    machineId: 'm1',
    path: '~/images',
    presets: [],
    kind: 'image-styles',
    spaceType: 'default',
    imageStyleIds: ['white-product'],
    imageVariantsPerStyle: 2,
};

describe('imageAgentMode', () => {
    it('defines the direct compose route for built-in GPT Image 2 image mode', () => {
        expect(IMAGE_STYLE_COMPOSE_ROUTE).toBe('/new?mode=image-styles');
    });

    it('creates a built-in image style agent with every canonical effect selected', () => {
        const agent = createBuiltinImageStyleAgent();

        expect(agent.kind).toBe('image-styles');
        expect(agent.spaceType).toBe('default');
        expect(agent.presets).toEqual([]);
        expect(agent.imageVariantsPerStyle).toBe(1);
        expect(agent.imageStyleIds).toEqual(IMAGE_AGENT_STYLE_PRESETS.map((style) => style.id));
    });

    it('resolves the built-in image agent from route mode without requiring a saved agent', () => {
        const resolved = resolveComposeImageAgent({
            routeMode: 'image-styles',
            agent: null,
            imagePluginInstalled: true,
        });

        expect(resolved?.id).toBe(createBuiltinImageStyleAgent().id);
        expect(resolved?.kind).toBe('image-styles');
    });

    it('keeps a saved image agent when one is launched explicitly', () => {
        const resolved = resolveComposeImageAgent({
            routeMode: 'image-styles',
            agent: savedImageAgent,
            imagePluginInstalled: true,
        });

        expect(resolved).toBe(savedImageAgent);
    });

    it('does not resolve image mode when the generated-images plugin is unavailable', () => {
        expect(resolveComposeImageAgent({
            routeMode: 'image-styles',
            agent: null,
            imagePluginInstalled: false,
        })).toBeNull();
        expect(resolveComposeImageAgent({
            routeMode: 'image-styles',
            agent: savedImageAgent,
            imagePluginInstalled: false,
        })).toBeNull();
    });

    it('selects one style for the current image generation batch', () => {
        const selected = selectImageAgentStyle(createBuiltinImageStyleAgent(), 'white-product');

        expect(selected.imageStyleIds).toEqual(['white-product']);
        expect(selected.imageVariantsPerStyle).toBe(1);
    });

    it('toggles multiple styles for the current image generation batch', () => {
        const first = selectImageAgentStyle(createBuiltinImageStyleAgent(), 'image-effects/white-background-product@1.0.0');
        const second = toggleImageAgentStyle(first, 'image-effects/character-grid-portrait@1.0.0');
        const third = toggleImageAgentStyle(second, 'image-effects/white-background-product@1.0.0');

        expect(first.imageStyleIds).toEqual(['image-effects/white-background-product@1.0.0']);
        expect(second.imageStyleIds).toEqual([
            'image-effects/white-background-product@1.0.0',
            'image-effects/character-grid-portrait@1.0.0',
        ]);
        expect(third.imageStyleIds).toEqual(['image-effects/character-grid-portrait@1.0.0']);
        expect(third.imageVariantsPerStyle).toBe(1);
    });

    it('sets the image draw count for the current batch and clamps it to supported values', () => {
        const agent = createBuiltinImageStyleAgent();

        expect(setImageAgentVariantCount(agent, 3).imageVariantsPerStyle).toBe(3);
        expect(setImageAgentVariantCount(agent, 99).imageVariantsPerStyle).toBe(4);
        expect(setImageAgentVariantCount(agent, 0).imageVariantsPerStyle).toBe(1);
    });

    it('builds a style prompt that can be inserted into the composer', () => {
        const style = IMAGE_AGENT_STYLE_PRESETS.find((preset) => preset.id === 'image-effects/white-background-product@1.0.0');
        expect(style).toBeTruthy();

        const prompt = createImageStyleSelectionPrompt(style!);

        expect(prompt).toContain('image-effects/white-background-product@1.0.0');
        expect(prompt).toContain(`风格说明：${style!.promptHint}`);
        expect(prompt).not.toContain(style!.promptContent.slice(0, 120));
        expect(prompt).toContain('保留上传主体的身份特征');
    });
});
