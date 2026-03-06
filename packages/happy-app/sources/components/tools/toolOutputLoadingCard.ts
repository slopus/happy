type LoadingCardTheme = {
    colors: {
        surfaceHigh: string;
        text: string;
        textSecondary: string;
        modal: {
            border: string;
        };
    };
};

export function createToolOutputLoadingCardStyles(theme: LoadingCardTheme) {
    return {
        loadingCard: {
            backgroundColor: theme.colors.surfaceHigh,
            borderRadius: 6,
            padding: 12,
            minHeight: 42,
            justifyContent: 'center' as const,
            alignItems: 'flex-start' as const,
        },
        errorCard: {
            backgroundColor: theme.colors.surfaceHigh,
            borderRadius: 6,
            padding: 12,
        },
        summarySection: {
            borderTopWidth: 1,
            borderTopColor: theme.colors.modal.border,
            paddingTop: 12,
            marginTop: 12,
            gap: 10,
        },
        summaryRow: {
            gap: 4,
        },
        summaryKey: {
            color: theme.colors.textSecondary,
            fontSize: 12,
            fontWeight: '600' as const,
        },
        summaryValue: {
            color: theme.colors.text,
            fontSize: 13,
            lineHeight: 19,
        },
        errorText: {
            color: theme.colors.textSecondary,
            fontSize: 13,
            lineHeight: 18,
        },
    };
}

export function formatToolOutputSummaryValue(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}
