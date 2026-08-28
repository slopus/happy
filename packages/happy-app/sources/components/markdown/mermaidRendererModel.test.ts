import { describe, expect, it } from 'vitest';
import {
    createMermaidThemeConfig,
    executeDiagramCommand,
    serializeForInlineScript,
} from './mermaidRendererModel';

const lightTheme = {
    dark: false,
    colors: {
        divider: '#d7dce3',
        surface: '#ffffff',
        surfaceHigh: '#f4f6f8',
        surfaceHighest: '#eef1f4',
        surfacePressed: '#e8ebef',
        text: '#17202a',
        textSecondary: '#5f6b76',
    },
};

const darkTheme = {
    dark: true,
    colors: {
        divider: '#39424c',
        surface: '#12171c',
        surfaceHigh: '#1b2229',
        surfaceHighest: '#242c34',
        surfacePressed: '#303a45',
        text: '#f4f7fa',
        textSecondary: '#aeb8c2',
    },
};

describe('createMermaidThemeConfig', () => {
    it('maps a light app theme into Mermaid semantic colors', () => {
        expect(createMermaidThemeConfig(lightTheme)).toEqual({
            startOnLoad: false,
            theme: 'base',
            themeVariables: {
                background: '#eef1f4',
                darkMode: false,
                primaryBorderColor: '#d7dce3',
                primaryColor: '#f4f6f8',
                primaryTextColor: '#17202a',
                secondaryColor: '#ffffff',
                secondaryTextColor: '#17202a',
                tertiaryColor: '#e8ebef',
                tertiaryTextColor: '#17202a',
                lineColor: '#5f6b76',
                textColor: '#17202a',
                edgeLabelBackground: '#eef1f4',
                clusterBkg: '#ffffff',
                clusterBorder: '#d7dce3',
            },
        });
    });

    it('keeps the same semantic mapping while enabling Mermaid dark mode', () => {
        const config = createMermaidThemeConfig(darkTheme);

        expect(config.theme).toBe('base');
        expect(config.themeVariables).toMatchObject({
            background: '#242c34',
            darkMode: true,
            primaryColor: '#1b2229',
            primaryTextColor: '#f4f7fa',
            lineColor: '#aeb8c2',
        });
    });
});

describe('serializeForInlineScript', () => {
    it('round-trips diagram text without allowing a closing script tag', () => {
        const content = 'flowchart LR\nA[</script><script>alert(1)</script>] --> B';
        const serialized = serializeForInlineScript(content);

        expect(serialized).not.toContain('</script>');
        expect(JSON.parse(serialized)).toBe(content);
    });
});

describe('executeDiagramCommand', () => {
    it('routes each public command to the matching viewport operation', () => {
        const calls: string[] = [];
        const controller = {
            reset: () => calls.push('reset'),
            zoomIn: () => calls.push('zoomIn'),
            zoomOut: () => calls.push('zoomOut'),
        };

        executeDiagramCommand(controller, 'zoomIn');
        executeDiagramCommand(controller, 'zoomOut');
        executeDiagramCommand(controller, 'reset');

        expect(calls).toEqual(['zoomIn', 'zoomOut', 'reset']);
    });
});
