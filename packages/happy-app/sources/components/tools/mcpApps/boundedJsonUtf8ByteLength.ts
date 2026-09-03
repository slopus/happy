export type BoundedJsonUtf8ByteLengthOptions = Readonly<{
    maxBytes: number;
    maxDepth?: number;
    maxNodes?: number;
}>;

type CountResult = 'counted' | 'omitted' | 'unknown';

const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_NODES = 262_145;

/**
 * Counts the UTF-8 bytes that JSON.stringify would produce without creating the
 * serialized string or an encoded buffer. Values that would require executing
 * user code, or that exhaust the structural limits, deliberately return null.
 */
export function boundedJsonUtf8ByteLength(
    value: unknown,
    options: BoundedJsonUtf8ByteLengthOptions,
): number | null {
    const maxBytes = options.maxBytes;
    const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0
        || !Number.isSafeInteger(maxDepth) || maxDepth < 0
        || !Number.isSafeInteger(maxNodes) || maxNodes <= 0) {
        return null;
    }

    let bytes = 0;
    let nodes = 0;
    let capped = false;
    const ancestors = new Set<object>();

    const addBytes = (additionalBytes: number): void => {
        if (capped) {
            return;
        }
        if (additionalBytes >= maxBytes - bytes) {
            bytes = maxBytes;
            capped = true;
            return;
        }
        bytes += additionalBytes;
    };

    const countJsonString = (text: string): void => {
        addBytes(1);
        for (let index = 0; index < text.length && !capped; index += 1) {
            const codeUnit = text.charCodeAt(index);
            if (codeUnit === 0x22 || codeUnit === 0x5c) {
                addBytes(2);
            } else if (codeUnit === 0x08 || codeUnit === 0x09 || codeUnit === 0x0a
                || codeUnit === 0x0c || codeUnit === 0x0d) {
                addBytes(2);
            } else if (codeUnit <= 0x1f) {
                addBytes(6);
            } else if (codeUnit <= 0x7f) {
                addBytes(1);
            } else if (codeUnit <= 0x7ff) {
                addBytes(2);
            } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
                const nextCodeUnit = text.charCodeAt(index + 1);
                if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
                    addBytes(4);
                    index += 1;
                } else {
                    addBytes(6);
                }
            } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
                addBytes(6);
            } else {
                addBytes(3);
            }
        }
        addBytes(1);
    };

    const countValue = (current: unknown, depth: number): CountResult => {
        if (capped) {
            return 'counted';
        }
        nodes += 1;
        if (nodes > maxNodes || depth > maxDepth) {
            return 'unknown';
        }

        if (current === null) {
            addBytes(4);
            return 'counted';
        }

        switch (typeof current) {
            case 'string':
                countJsonString(current);
                return 'counted';
            case 'boolean':
                addBytes(current ? 4 : 5);
                return 'counted';
            case 'number': {
                const serialized = Number.isFinite(current) ? String(current) : 'null';
                addBytes(serialized.length);
                return 'counted';
            }
            case 'undefined':
            case 'function':
            case 'symbol':
                return 'omitted';
            case 'bigint':
                return 'unknown';
            case 'object':
                break;
            default:
                return 'unknown';
        }

        const object = current as object;
        if (ancestors.has(object)) {
            return 'unknown';
        }

        let isArray: boolean;
        try {
            isArray = Array.isArray(object);
        } catch {
            return 'unknown';
        }

        let prototype: object | null;
        try {
            prototype = Object.getPrototypeOf(object) as object | null;
        } catch {
            return 'unknown';
        }
        if (isArray ? prototype !== Array.prototype : prototype !== null && prototype !== Object.prototype) {
            return 'unknown';
        }

        try {
            if (prototype !== null && Object.getPrototypeOf(Object.prototype) !== null) {
                return 'unknown';
            }
            if (isArray && Object.getPrototypeOf(Array.prototype) !== Object.prototype) {
                return 'unknown';
            }
            const ownToJson = Object.getOwnPropertyDescriptor(object, 'toJSON');
            const arrayPrototypeToJson = isArray
                ? Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON')
                : undefined;
            const objectPrototypeToJson = prototype !== null
                ? Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON')
                : undefined;
            if (ownToJson !== undefined || arrayPrototypeToJson !== undefined || objectPrototypeToJson !== undefined) {
                return 'unknown';
            }
        } catch {
            return 'unknown';
        }

        ancestors.add(object);
        try {
            if (isArray) {
                let lengthDescriptor: PropertyDescriptor | undefined;
                try {
                    lengthDescriptor = Object.getOwnPropertyDescriptor(object, 'length');
                } catch {
                    return 'unknown';
                }
                const length = lengthDescriptor?.value;
                if (!Number.isSafeInteger(length) || length < 0) {
                    return 'unknown';
                }

                addBytes(1);
                for (let index = 0; index < length && !capped; index += 1) {
                    if (index > 0) {
                        addBytes(1);
                    }
                    let descriptor: PropertyDescriptor | undefined;
                    try {
                        descriptor = Object.getOwnPropertyDescriptor(object, String(index));
                    } catch {
                        return 'unknown';
                    }
                    if (descriptor !== undefined && !('value' in descriptor)) {
                        return 'unknown';
                    }
                    if (descriptor === undefined) {
                        nodes += 1;
                        if (nodes > maxNodes) {
                            return 'unknown';
                        }
                        addBytes(4);
                        continue;
                    }
                    const result = countValue(descriptor.value, depth + 1);
                    if (result === 'unknown') {
                        return 'unknown';
                    }
                    if (result === 'omitted') {
                        addBytes(4);
                    }
                }
                addBytes(1);
                return 'counted';
            }

            addBytes(1);
            let includedProperties = 0;
            try {
                for (const key in object) {
                    if (capped) {
                        break;
                    }
                    const descriptor = Object.getOwnPropertyDescriptor(object, key);
                    // for...in can include an enumerable Object.prototype extension;
                    // JSON.stringify only visits own enumerable string properties.
                    if (descriptor === undefined) {
                        continue;
                    }
                    if (!('value' in descriptor)) {
                        return 'unknown';
                    }
                    const propertyValue = descriptor.value;
                    if (propertyValue === undefined || typeof propertyValue === 'function' || typeof propertyValue === 'symbol') {
                        nodes += 1;
                        if (nodes > maxNodes) {
                            return 'unknown';
                        }
                        continue;
                    }
                    if (includedProperties > 0) {
                        addBytes(1);
                    }
                    countJsonString(key);
                    addBytes(1);
                    const result = countValue(propertyValue, depth + 1);
                    if (result !== 'counted') {
                        return 'unknown';
                    }
                    includedProperties += 1;
                }
            } catch {
                return 'unknown';
            }
            addBytes(1);
            return 'counted';
        } finally {
            ancestors.delete(object);
        }
    };

    const result = countValue(value, 0);
    return result === 'counted' ? bytes : null;
}
