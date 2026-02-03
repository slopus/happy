/**
 * Deep comparison utility for tool calls
 * Compares tool name and arguments to determine if two tool calls are the same
 */
export function compareToolCalls(
    tool1: { name: string; arguments: any },
    tool2: { name: string; arguments: any }
): boolean {
    // Compare tool names (case-sensitive)
    if (tool1.name !== tool2.name) {
        return false;
    }

    // Compare arguments using deep equality
    return deepEqual(tool1.arguments, tool2.arguments);
}

/**
 * Deep equality comparison for any values
 * Handles primitives, arrays, objects, null, undefined, etc.
 */
function deepEqual(a: any, b: any): boolean {
    // Handle exact equality (including null, undefined, primitives)
    if (a === b) {
        return true;
    }

    // Handle null/undefined cases
    if (a === null || b === null || a === undefined || b === undefined) {
        return false;
    }

    // Handle different types
    if (typeof a !== typeof b) {
        return false;
    }

    // Handle arrays
    if (Array.isArray(a)) {
        if (!Array.isArray(b) || a.length !== b.length) {
            return false;
        }
        for (let i = 0; i < a.length; i++) {
            if (!deepEqual(a[i], b[i])) {
                return false;
            }
        }
        return true;
    }

    // Handle objects
    if (typeof a === 'object') {
        const keysA = Object.keys(a).sort();
        const keysB = Object.keys(b).sort();
        
        if (keysA.length !== keysB.length) {
            return false;
        }
        
        for (let i = 0; i < keysA.length; i++) {
            if (keysA[i] !== keysB[i]) {
                return false;
            }
            if (!deepEqual(a[keysA[i]], b[keysB[i]])) {
                return false;
            }
        }
        return true;
    }

    // For all other types (numbers, strings, booleans, functions, etc.)
    return false;
}