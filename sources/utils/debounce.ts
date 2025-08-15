export interface DebounceOptions<T> {
    delay: number;
    immediateCount?: number;
    reducer?: (previous: T, current: T) => T;
}

export function createCustomDebounce<T>(
    fn: (args: T) => void,
    options: DebounceOptions<T>
): (args: T) => void {
    const { delay, immediateCount = 2, reducer } = options;
    
    let callCount = 0;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let pendingArgs: T | null = null;
    
    return function debouncedFunction(args: T): void {
        // First few calls execute immediately
        if (callCount < immediateCount) {
            callCount++;
            fn(args);
            return;
        }
        
        // After immediate calls, apply debouncing
        if (pendingArgs !== null && reducer) {
            // Combine the pending args with new args using the reducer
            pendingArgs = reducer(pendingArgs, args);
        } else {
            // Default behavior: use the latest args
            pendingArgs = args;
        }
        
        // Clear existing timeout
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
        
        // Set new timeout
        timeoutId = setTimeout(() => {
            if (pendingArgs !== null) {
                fn(pendingArgs);
                pendingArgs = null;
            }
            timeoutId = null;
        }, delay);
    };
}

export function createAdvancedDebounce<T>(
    fn: (args: T) => void,
    options: DebounceOptions<T>
): {
    debounced: (args: T) => void;
    cancel: () => void;
    reset: () => void;
    flush: () => void;
} {
    const { delay, immediateCount = 2, reducer } = options;
    
    let callCount = 0;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let pendingArgs: T | null = null;
    
    const cancel = () => {
        if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
        }
        pendingArgs = null;
    };
    
    const reset = () => {
        cancel();
        callCount = 0;
    };
    
    const flush = () => {
        if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
        }
        if (pendingArgs !== null) {
            fn(pendingArgs);
            pendingArgs = null;
        }
    };
    
    const debounced = function(args: T): void {
        // First few calls execute immediately
        if (callCount < immediateCount) {
            callCount++;
            fn(args);
            return;
        }
        
        // After immediate calls, apply debouncing
        if (pendingArgs !== null && reducer) {
            // Combine the pending args with new args using the reducer
            pendingArgs = reducer(pendingArgs, args);
        } else {
            // Default behavior: use the latest args
            pendingArgs = args;
        }
        
        // Clear existing timeout
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
        
        // Set new timeout
        timeoutId = setTimeout(() => {
            if (pendingArgs !== null) {
                fn(pendingArgs);
                pendingArgs = null;
            }
            timeoutId = null;
        }, delay);
    };
    
    return { debounced, cancel, reset, flush };
}