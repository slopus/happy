export function isPublicSessionSharePath(pathname: string | null | undefined): boolean {
    return /^\/share\/[^/]+\/?$/.test(pathname ?? '');
}

export function isPublicSessionShareBrowserPath(): boolean {
    return typeof globalThis.location?.pathname === 'string'
        && isPublicSessionSharePath(globalThis.location.pathname);
}
