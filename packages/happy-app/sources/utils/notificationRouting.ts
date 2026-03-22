function getObjectValue(value: unknown, key: string): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    return (value as Record<string, unknown>)[key];
}

function parseJson(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function normalizeNotificationData(data: unknown): unknown {
    if (typeof data === 'string') {
        return parseJson(data);
    }
    return data;
}

function getSessionRouteFromUrl(url: string): `/session/${string}` | null {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
        return null;
    }

    const match = trimmedUrl.match(/(?:^|\/)session\/([^/?#]+)/);
    if (!match) {
        return null;
    }

    const encodedSessionId = match[1];
    const sessionId = (() => {
        try {
            return decodeURIComponent(encodedSessionId);
        } catch {
            return encodedSessionId;
        }
    })();

    const trimmedSessionId = sessionId.trim();
    if (!trimmedSessionId) {
        return null;
    }

    return `/session/${encodeURIComponent(trimmedSessionId)}`;
}

export function getSessionRouteFromNotificationData(data: unknown): `/session/${string}` | null {
    const normalizedData = normalizeNotificationData(data);
    if (!normalizedData || typeof normalizedData !== 'object' || Array.isArray(normalizedData)) {
        return null;
    }

    const url = getObjectValue(normalizedData, 'url');
    if (typeof url === 'string') {
        const routeFromUrl = getSessionRouteFromUrl(url);
        if (routeFromUrl) {
            return routeFromUrl;
        }
    }

    const sessionId = getObjectValue(normalizedData, 'sessionId');
    if (typeof sessionId !== 'string') {
        return null;
    }

    const trimmedSessionId = sessionId.trim();
    if (!trimmedSessionId) {
        return null;
    }

    return `/session/${encodeURIComponent(trimmedSessionId)}`;
}

export function getSessionRouteFromNotificationResponse(response: unknown): `/session/${string}` | null {
    const contentData = getObjectValue(getObjectValue(getObjectValue(response, 'notification'), 'request'), 'content');
    return getSessionRouteFromNotificationData(getObjectValue(contentData, 'data'));
}
