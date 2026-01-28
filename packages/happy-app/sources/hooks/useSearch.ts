import { useEffect, useRef, useState, useCallback } from 'react';

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
 * @returns Object with results array and isSearching boolean
 */
export function useSearch<T>(
    query: string,
    searchFn: (query: string) => Promise<T[]>
): { results: T[]; isSearching: boolean } {
    const [results, setResults] = useState<T[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    
    // Permanent cache for search results
    const cacheRef = useRef<Map<string, T[]>>(new Map());
    
    // Ref to prevent parallel queries
    const isSearchingRef = useRef(false);
    
    // Timeout ref for debouncing
    const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    
    // Perform the search with retry logic
    const performSearch = useCallback(async (searchQuery: string) => {
        // Skip if already searching
        if (isSearchingRef.current) {
            return;
        }
        
        // Check cache first
        const cached = cacheRef.current.get(searchQuery);
        if (cached) {
            setResults(cached);
            return;
        }
        
        // Mark as searching
        isSearchingRef.current = true;
        setIsSearching(true);
        
        // Retry logic with exponential backoff
        let retryDelay = 1000; // Start with 1 second
        
        while (true) {
            try {
                const searchResults = await searchFn(searchQuery);
                
                // Cache the results
                cacheRef.current.set(searchQuery, searchResults);
                
                // Update state
                setResults(searchResults);
                break; // Success, exit the retry loop
                
            } catch (error) {
                // Wait before retrying
                await new Promise(resolve => setTimeout(resolve, retryDelay));
                
                // Exponential backoff with max delay of 30 seconds
                retryDelay = Math.min(retryDelay * 2, 30000);
                
                // Continue retrying (loop will continue)
            }
        }
        
        // Mark as not searching
        isSearchingRef.current = false;
        setIsSearching(false);
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
            return;
        }
        
        // Check cache immediately
        const cached = cacheRef.current.get(query);
        if (cached) {
            setResults(cached);
            setIsSearching(false);
            return;
        }
        
        // Set searching state immediately for better UX
        setIsSearching(true);
        
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
    
    return { results, isSearching };
}