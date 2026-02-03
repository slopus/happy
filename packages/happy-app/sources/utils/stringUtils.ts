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