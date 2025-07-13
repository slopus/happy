/**
 * Merges two objects while ignoring undefined values from the second object.
 * This is useful when you want to update an object but not override existing values with undefined.
 */
export function mergeObjects<T>(base: T & object, updates: Partial<T>): T {
    const filtered = Object.fromEntries(
        Object.entries(updates).filter(([_, value]) => value !== undefined)
    );
    return { ...base, ...filtered } as T;
} 