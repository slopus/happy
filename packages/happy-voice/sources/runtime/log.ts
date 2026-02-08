export function logInfo(message: string, data?: unknown) {
    if (data === undefined) {
        console.log(`[happy-voice] ${message}`);
        return;
    }
    console.log(`[happy-voice] ${message}`, data);
}

export function logWarn(message: string, data?: unknown) {
    if (data === undefined) {
        console.warn(`[happy-voice] ${message}`);
        return;
    }
    console.warn(`[happy-voice] ${message}`, data);
}

export function logError(message: string, data?: unknown) {
    if (data === undefined) {
        console.error(`[happy-voice] ${message}`);
        return;
    }
    console.error(`[happy-voice] ${message}`, data);
}
