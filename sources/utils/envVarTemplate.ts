export type EnvVarTemplateOperator = ':-' | ':=';

export type EnvVarTemplate = Readonly<{
    sourceVar: string;
    fallback: string;
    operator: EnvVarTemplateOperator | null;
}>;

export function parseEnvVarTemplate(value: string): EnvVarTemplate | null {
    const withFallback = value.match(/^\$\{([A-Z_][A-Z0-9_]*)(:-|:=)(.*)\}$/);
    if (withFallback) {
        return {
            sourceVar: withFallback[1],
            operator: withFallback[2] as EnvVarTemplateOperator,
            fallback: withFallback[3],
        };
    }

    const noFallback = value.match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/);
    if (noFallback) {
        return {
            sourceVar: noFallback[1],
            operator: null,
            fallback: '',
        };
    }

    return null;
}

export function formatEnvVarTemplate(params: {
    sourceVar: string;
    fallback: string;
    operator?: EnvVarTemplateOperator | null;
}): string {
    const operator: EnvVarTemplateOperator | null = params.operator ?? (params.fallback !== '' ? ':-' : null);
    const suffix = operator ? `${operator}${params.fallback}` : '';
    return `\${${params.sourceVar}${suffix}}`;
}

