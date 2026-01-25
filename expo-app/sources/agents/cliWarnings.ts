export type DismissedCliWarnings = Readonly<{
    perMachine: Readonly<Record<string, Readonly<Record<string, boolean>>>>;
    global: Readonly<Record<string, boolean>>;
}>;

export type CliWarningDismissScope = 'machine' | 'global';

export function isCliWarningDismissed(params: {
    dismissed: DismissedCliWarnings | null | undefined;
    machineId: string | null | undefined;
    warningKey: string;
}): boolean {
    const dismissed = params.dismissed;
    if (!dismissed) return false;
    if (dismissed.global?.[params.warningKey] === true) return true;
    if (!params.machineId) return false;
    return dismissed.perMachine?.[params.machineId]?.[params.warningKey] === true;
}

export function applyCliWarningDismissal(params: {
    dismissed: DismissedCliWarnings | null | undefined;
    machineId: string | null | undefined;
    warningKey: string;
    scope: CliWarningDismissScope;
}): DismissedCliWarnings {
    const base: DismissedCliWarnings = params.dismissed ?? { perMachine: {}, global: {} };

    if (params.scope === 'global') {
        return {
            ...base,
            global: {
                ...(base.global ?? {}),
                [params.warningKey]: true,
            },
        };
    }

    if (!params.machineId) {
        return base;
    }

    const existing = base.perMachine?.[params.machineId] ?? {};
    return {
        ...base,
        perMachine: {
            ...(base.perMachine ?? {}),
            [params.machineId]: {
                ...existing,
                [params.warningKey]: true,
            },
        },
    };
}

