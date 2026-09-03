export type BrowserRequestFailure = {
    description: string;
    error: string;
    resourceType: string;
    url: string;
};

export type BrowserResponseSummary = {
    method: string;
    origin: string;
    pathname: string;
    status: number;
};

export type ExpectedBrowserResponse = BrowserResponseSummary & {
    enabled: () => boolean;
    expectedCount: number;
    label: string;
};

export function isAllowedLifecycleAbort(
    failure: BrowserRequestFailure,
    allowedUrlPrefixes: readonly string[],
): boolean {
    return failure.error === 'net::ERR_ABORTED'
        && (failure.resourceType === 'image' || failure.resourceType === 'media')
        && allowedUrlPrefixes.some((prefix) => failure.url.startsWith(prefix));
}

export function matchesExpectedBrowserResponse(
    actual: BrowserResponseSummary,
    expected: ExpectedBrowserResponse,
): boolean {
    return expected.enabled()
        && actual.origin === expected.origin
        && actual.method === expected.method
        && actual.pathname === expected.pathname
        && actual.status === expected.status;
}

export function browserResponseConsoleKey(response: BrowserResponseSummary): string {
    return `${response.status} ${response.origin}${response.pathname}`;
}
