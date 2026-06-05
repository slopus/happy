/**
 * Thumbhash generation/decode — native stub.
 * Returns undefined on native platforms (no Canvas / data-URL plumbing).
 * Web implementation in thumbhash.web.ts uses the Canvas API.
 */

export async function generateThumbhash(
    _uri: string,
    _width: number,
    _height: number,
): Promise<string | undefined> {
    return undefined;
}

export function thumbhashToDataUri(_thumbhashBase64: string): string | undefined {
    return undefined;
}
