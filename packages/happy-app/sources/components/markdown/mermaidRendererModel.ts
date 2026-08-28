export type MermaidThemeSource = {
    dark: boolean;
    colors: {
        divider: string;
        surface: string;
        surfaceHigh: string;
        surfaceHighest: string;
        surfacePressed: string;
        text: string;
        textSecondary: string;
    };
};

export type MermaidThemeConfig = {
    startOnLoad: false;
    theme: 'base';
    themeVariables: {
        background: string;
        darkMode: boolean;
        primaryBorderColor: string;
        primaryColor: string;
        primaryTextColor: string;
        secondaryColor: string;
        secondaryTextColor: string;
        tertiaryColor: string;
        tertiaryTextColor: string;
        lineColor: string;
        textColor: string;
        edgeLabelBackground: string;
        clusterBkg: string;
        clusterBorder: string;
    };
};

export type DiagramCommand = 'reset' | 'zoomIn' | 'zoomOut';

export type DiagramCommandTarget = Record<DiagramCommand, (options?: { animate?: boolean }) => unknown>;

export function executeDiagramCommand(target: DiagramCommandTarget, command: DiagramCommand): void {
    target[command]({ animate: true });
}

export function createMermaidThemeConfig(theme: MermaidThemeSource): MermaidThemeConfig {
    const { colors } = theme;
    return {
        startOnLoad: false,
        theme: 'base',
        themeVariables: {
            background: colors.surfaceHighest,
            darkMode: theme.dark,
            primaryBorderColor: colors.divider,
            primaryColor: colors.surfaceHigh,
            primaryTextColor: colors.text,
            secondaryColor: colors.surface,
            secondaryTextColor: colors.text,
            tertiaryColor: colors.surfacePressed,
            tertiaryTextColor: colors.text,
            lineColor: colors.textSecondary,
            textColor: colors.text,
            edgeLabelBackground: colors.surfaceHighest,
            clusterBkg: colors.surface,
            clusterBorder: colors.divider,
        },
    };
}

export function serializeForInlineScript(value: unknown): string {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026');
}
