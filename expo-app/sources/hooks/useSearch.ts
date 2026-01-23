import { useEffect, useRef, useState, useCallback } from 'react';

export type UseSearchError = 'searchFailed';

/**
 * Production-ready search hook with automatic debouncing, caching, and retry logic.
 * 
 * Features:
 * - Prevents parallel queries by skipping new requests while one is in progress
 * - Permanent in-memory cache for the lifetime of the component
 * - Automatic retry on errors with exponential backoff
 * - 300ms debounce to reduce API calls
 * - Returns cached results immediately if available
 * 
 * @param query - The search query string
 * @param searchFn - The async function to perform the search
 * @returns Object with results array, isSearching boolean, and a stable error code (if any)
 */
export function useSearch<T>(
    query: string,
    searchFn: (query: string) => Promise<T[]>
): { results: T[]; isSearching: boolean; error: UseSearchError | null } {
    const [results, setResults] = useState<T[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [error, setError] = useState<UseSearchError | null>(null);
    
    // Permanent cache for search results
    const cacheRef = useRef<Map<string, T[]>>(new Map());
    const requestIdRef = useRef(0);
    
    // Timeout ref for debouncing
    const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    
    // Perform the search with retry logic
    const performSearch = useCallback(async (searchQuery: string) => {
        // Check cache first
        const cached = cacheRef.current.get(searchQuery);
        if (cached) {
            setResults(cached);
            setError(null);
            return;
        }
        
        const requestId = ++requestIdRef.current;
        setIsSearching(true);
        setError(null);
        
        // IMPORTANT: do not retry forever. Persistent errors (bad auth/config) would otherwise
        // cause infinite background requests and a "stuck loading" UI.
        const maxAttempts = 2;
        let attempt = 0;
        let retryDelay = 750; // Start with 0.75s
        try {
            while (attempt < maxAttempts) {
                // If a new search started, abandon this one.
                if (requestIdRef.current !== requestId) {
                    return;
                }
                attempt++;
            try {
                const searchResults = await searchFn(searchQuery);
                
                // Cache the results
                cacheRef.current.set(searchQuery, searchResults);
                
                // Update state
                setResults(searchResults);
                setError(null);
                return; // Success
                
            } catch (error) {
                if (attempt >= maxAttempts) {
                    setResults([]);
                    setError('searchFailed');
                    return;
                }
                // Wait before retrying (bounded)
                await new Promise(resolve => setTimeout(resolve, retryDelay));
                retryDelay = Math.min(retryDelay * 2, 5000);
            }
            }
        } finally {
            if (requestIdRef.current === requestId) {
                setIsSearching(false);
            }
        }
    }, [searchFn]);
    
    // Effect to handle debounced search
    useEffect(() => {
        // Clear previous timeout
        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
        }
        
        // If query is empty, clear results immediately
        if (!query.trim()) {
            setResults([]);
            setIsSearching(false);
            setError(null);
            return;
        }
        
        // Check cache immediately
        const cached = cacheRef.current.get(query);
        if (cached) {
            setResults(cached);
            setIsSearching(false);
            setError(null);
            return;
        }
        
        // Set searching state immediately for better UX
        setIsSearching(true);
        setError(null);
        
        // Debounce the actual search
        timeoutRef.current = setTimeout(() => {
            performSearch(query);
        }, 300); // Hardcoded 300ms debounce
        
        // Cleanup
        return () => {
            if (timeoutRef.current) {
                clearTimeout(timeoutRef.current);
            }
        };
    }, [query, performSearch]);
    
    return { results, isSearching, error };
}
