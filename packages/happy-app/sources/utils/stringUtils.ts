/**
 * Convert a string to camelCase
 * Examples:
 * - "Hello World" -> "helloWorld"
 * - "create user authentication" -> "createUserAuthentication"
 * - "API-endpoint-handler" -> "apiEndpointHandler"
 */
export function toCamelCase(str: string): string {
    // Remove special characters and split by spaces, hyphens, underscores
    const words = str
        .replace(/[^\w\s-]/g, '') // Remove special chars except spaces and hyphens
        .split(/[\s-_]+/) // Split by spaces, hyphens, underscores
        .filter(word => word.length > 0);

    if (words.length === 0) return '';

    // First word lowercase, rest capitalize first letter
    return words
        .map((word, index) => {
            const lowercased = word.toLowerCase();
            if (index === 0) {
                return lowercased;
            }
            return lowercased.charAt(0).toUpperCase() + lowercased.slice(1);
        })
        .join('');
}

/**
 * UTF-8 safe, URL-safe base64 encoding.
 * Replaces +, /, = with URL-safe characters (-, _, no padding).
 */
export function utf8ToBase64(str: string): string {
    const b64 = btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g,
        (_, p1) => String.fromCharCode(parseInt(p1, 16))));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * UTF-8 safe, URL-safe base64 decoding (inverse of utf8ToBase64).
 * Accepts both standard and URL-safe base64.
 */
export function base64ToUtf8(str: string): string {
    // Restore standard base64 from URL-safe variant (also handle + parsed as space)
    let b64 = str.replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/');
    // Re-add padding
    while (b64.length % 4) b64 += '=';
    return decodeURIComponent(
        atob(b64).split('').map(c =>
            '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
        ).join('')
    );
}

/**
 * Create a safe filename from a string
 * Removes/replaces characters that might cause issues in filenames
 */
export function toSafeFileName(str: string): string {
    return str
        .replace(/[<>:"/\\|?*]/g, '') // Remove unsafe chars for filenames
        .replace(/\s+/g, '-') // Replace spaces with hyphens
        .replace(/-+/g, '-') // Replace multiple hyphens with single
        .replace(/^-+|-+$/g, '') // Remove leading/trailing hyphens
        .toLowerCase()
        .substring(0, 100); // Limit length to 100 chars
}