export function normalizeOptionalParam(value?: string | string[]) {
    if (Array.isArray(value)) {
        return value[0];
    }
    return value;
}

export function consumeProfileIdParam(params: {
    profileIdParam?: string | string[];
    selectedProfileId: string | null;
}): {
    nextSelectedProfileId: string | null | undefined;
    shouldClearParam: boolean;
} {
    const nextProfileIdFromParams = normalizeOptionalParam(params.profileIdParam);

    if (typeof nextProfileIdFromParams !== 'string') {
        return { nextSelectedProfileId: undefined, shouldClearParam: false };
    }

    if (nextProfileIdFromParams === '') {
        return { nextSelectedProfileId: null, shouldClearParam: true };
    }

    if (nextProfileIdFromParams === params.selectedProfileId) {
        // Nothing to do, but still clear it so it doesn't lock the selection.
        return { nextSelectedProfileId: undefined, shouldClearParam: true };
    }

    return { nextSelectedProfileId: nextProfileIdFromParams, shouldClearParam: true };
}

