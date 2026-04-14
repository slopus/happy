/**
 * Thumbhash generation — native stub.
 * Returns undefined on native platforms (no Canvas API available).
 * Web implementation in thumbhash.web.ts uses the Canvas API.
 */

export async function generateThumbhash(
    _uri: string,
    _width: number,
    _height: number,
): Promise<string | undefined> {
    return undefined;
}
