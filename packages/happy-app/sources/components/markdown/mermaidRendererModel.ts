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
        fontSize: string;
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

/** Fit the natural SVG dimensions into a viewport without enlarging a small diagram. */
export function getDiagramFitScale(width: number, height: number, viewportWidth: number, viewportHeight: number): number {
    if (![width, height, viewportWidth, viewportHeight].every(value => Number.isFinite(value) && value > 0)) return 1;
    return Math.min(1, viewportWidth / width, viewportHeight / height);
}

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
            // Match the 16px Markdown body; desktop previews keep the SVG's natural scale.
            fontSize: '16px',
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
