import { useCallback, useRef, useState } from 'react';

interface UseMultiClickOptions {
    /** Number of clicks required to trigger the callback */
    requiredClicks: number;
    /** Timeout in milliseconds to reset the click count (default: 2000) */
    resetTimeout?: number;
    /** Optional callback when click count changes */
    onClickCountChange?: (count: number) => void;
}

/**
 * Hook that invokes a callback after N consecutive clicks within a timeout window.
 * Similar to useCallback but triggers only on the Nth click.
 * 
 * @param callback - The function to call when N clicks are reached
 * @param options - Configuration options
 * @returns A click handler function to attach to onClick events
 */
export function useMultiClick(
    callback: () => void,
    options: UseMultiClickOptions
): () => void {
    const { requiredClicks, resetTimeout = 2000, onClickCountChange } = options;
    const [clickCount, setClickCount] = useState(0);
    const resetTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    const handleClick = useCallback(() => {
        // Clear existing timer
        if (resetTimerRef.current) {
            clearTimeout(resetTimerRef.current);
        }

        const newCount = clickCount + 1;
        setClickCount(newCount);
        
        // Notify about click count change
        onClickCountChange?.(newCount);

        if (newCount >= requiredClicks) {
            // Trigger the callback
            callback();
            // Reset count
            setClickCount(0);
            onClickCountChange?.(0);
        } else {
            // Set timer to reset count after timeout
            resetTimerRef.current = setTimeout(() => {
                setClickCount(0);
                onClickCountChange?.(0);
            }, resetTimeout);
        }
    }, [callback, clickCount, requiredClicks, resetTimeout, onClickCountChange]);

    return handleClick;
}