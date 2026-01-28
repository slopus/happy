/**
 * Deterministic JSON utilities for consistent object serialization and hashing
 * 
 * Provides stable JSON stringification with sorted keys and consistent handling
 * of edge cases like undefined, circular references, and special types.
 * 
 * Used for:
 * - Consistent encryption/decryption in API communication
 * - Reliable message deduplication in session scanning
 * - Stable object comparison for optimistic concurrency
 */

import { createHash } from 'crypto';

/**
 * Options for deterministic JSON stringification
 */
export interface DeterministicJsonOptions {
    /** How to handle undefined values */
    undefinedBehavior?: 'omit' | 'null' | 'throw';
    /** Whether to sort array contents (default: false) */
    sortArrays?: boolean;
    /** Custom replacer function */
    replacer?: (key: string, value: any) => any;
    /** Whether to include Symbol properties (default: false) */
    includeSymbols?: boolean;
}

/**
 * Deterministically stringify a JSON object with sorted keys
 * 
 * @param obj Object to stringify
 * @param options Stringification options
 * @returns Deterministic JSON string
 */
export function deterministicStringify(
    obj: any,
    options: DeterministicJsonOptions = {}
): string {
    const {
        undefinedBehavior = 'omit',
        sortArrays = false,
        replacer,
        includeSymbols = false
    } = options;

    const seen = new WeakSet();

    function processValue(value: any, key?: string): any {
        // Handle replacer function
        if (replacer && key !== undefined) {
            value = replacer(key, value);
        }

        // Handle primitive types
        if (value === null) return null;
        if (value === undefined) {
            switch (undefinedBehavior) {
                case 'omit': return undefined;
                case 'null': return null;
                case 'throw': throw new Error(`Undefined value at key: ${key}`);
            }
        }
        if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
            return value;
        }

        // Handle special types
        if (value instanceof Date) {
            return value.toISOString();
        }
        if (value instanceof RegExp) {
            return value.toString();
        }
        if (typeof value === 'function') {
            return undefined; // Functions are omitted
        }
        if (typeof value === 'symbol') {
            return includeSymbols ? value.toString() : undefined;
        }
        if (typeof value === 'bigint') {
            return value.toString() + 'n';
        }

        // Handle circular references
        if (seen.has(value)) {
            throw new Error('Circular reference detected');
        }
        seen.add(value);

        // Handle arrays
        if (Array.isArray(value)) {
            const processed = value.map((item, index) => processValue(item, String(index)))
                .filter(item => item !== undefined);
            
            if (sortArrays) {
                // Sort arrays by their stringified content for true determinism
                processed.sort((a, b) => {
                    const aStr = JSON.stringify(processValue(a));
                    const bStr = JSON.stringify(processValue(b));
                    return aStr.localeCompare(bStr);
                });
            }
            
            seen.delete(value);
            return processed;
        }

        // Handle objects
        if (value.constructor === Object || value.constructor === undefined) {
            const processed: Record<string, any> = {};
            const keys = Object.keys(value).sort();

            for (const k of keys) {
                const processedValue = processValue(value[k], k);
                if (processedValue !== undefined) {
                    processed[k] = processedValue;
                }
            }

            seen.delete(value);
            return processed;
        }

        // Handle other object types (like class instances)
        // Try to convert to plain object
        try {
            const plain = { ...value };
            seen.delete(value);
            return processValue(plain, key);
        } catch {
            seen.delete(value);
            return String(value);
        }
    }

    const processed = processValue(obj);
    return JSON.stringify(processed);
}

/**
 * Calculate SHA-256 hash of an object using deterministic JSON stringification
 * 
 * @param obj Object to hash
 * @param options Stringification options
 * @param encoding Output encoding (default: 'hex')
 * @returns Hash string
 */
export function hashObject(
    obj: any,
    options?: DeterministicJsonOptions,
    encoding: 'hex' | 'base64' | 'base64url' = 'hex'
): string {
    const jsonString = deterministicStringify(obj, options);
    return createHash('sha256').update(jsonString).digest(encoding);
}

/**
 * Compare two objects for deep equality using deterministic stringification
 * 
 * @param a First object
 * @param b Second object
 * @param options Stringification options
 * @returns True if objects are deeply equal
 */
export function deepEqual(
    a: any,
    b: any,
    options?: DeterministicJsonOptions
): boolean {
    try {
        return deterministicStringify(a, options) === deterministicStringify(b, options);
    } catch {
        return false;
    }
}

/**
 * Create a stable hash key for an object suitable for use as a Map key
 * 
 * @param obj Object to create key for
 * @param options Stringification options
 * @returns Stable string key
 */
export function objectKey(
    obj: any,
    options?: DeterministicJsonOptions
): string {
    return hashObject(obj, options, 'base64url');
}