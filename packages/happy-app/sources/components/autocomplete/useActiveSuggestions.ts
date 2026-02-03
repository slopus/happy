import { ValueSync } from '@/utils/sync';
import * as React from 'react';

interface SuggestionOptions {
    clampSelection?: boolean;  // If true, clamp instead of preserving exact position
    autoSelectFirst?: boolean; // If true, automatically select first item when suggestions appear
    wrapAround?: boolean;      // If true, wrap around when reaching top/bottom
}

export function useActiveSuggestions(
    query: string | null, 
    handler: (query: string) => Promise<{
        key: string,
        text: string,
        component: React.ElementType
    }[]>,
    options: SuggestionOptions = {}
) {
    const { 
        clampSelection = true, 
        autoSelectFirst = true,
        wrapAround = true 
    } = options;

    // State for suggestions
    const [state, setState] = React.useState<{
        suggestions: { key: string, text: string, component: React.ElementType }[];
        selected: number,
    }>({
        suggestions: [],
        selected: -1
    });

    const moveUp = React.useCallback(() => {
        setState((prev) => {
            if (prev.suggestions.length === 0) return prev;
            
            if (prev.selected <= 0) {
                // At top or nothing selected
                if (wrapAround) {
                    return { ...prev, selected: prev.suggestions.length - 1 };
                } else {
                    return { ...prev, selected: 0 };
                }
            }
            // Move up
            return { ...prev, selected: prev.selected - 1 };
        });
    }, [wrapAround]);

    const moveDown = React.useCallback(() => {
        setState((prev) => {
            if (prev.suggestions.length === 0) return prev;
            
            if (prev.selected >= prev.suggestions.length - 1) {
                // At bottom
                if (wrapAround) {
                    return { ...prev, selected: 0 };
                } else {
                    return { ...prev, selected: prev.suggestions.length - 1 };
                }
            }
            // If nothing selected, select first
            if (prev.selected < 0) {
                return { ...prev, selected: 0 };
            }
            // Move down
            return { ...prev, selected: prev.selected + 1 };
        });
    }, [wrapAround]);

    // Sync query to suggestions
    const sync = React.useMemo(() => {
        return new ValueSync<string | null>(async (query) => {
            console.log('🎯 useActiveSuggestions: Processing query:', JSON.stringify(query));
            if (!query) {
                console.log('🎯 useActiveSuggestions: No query, skipping');
                return;
            }
            const suggestions = await handler(query);
            console.log('🎯 useActiveSuggestions: Got suggestions:', JSON.stringify(suggestions, (key, value) => {
                if (key === 'component') return '[Function]';
                return value;
            }, 2));
            setState((prev) => {
                if (clampSelection) {
                    // Simply clamp the selection to valid range
                    let newSelected = prev.selected;
                    
                    if (suggestions.length === 0) {
                        newSelected = -1;
                    } else if (autoSelectFirst && prev.suggestions.length === 0) {
                        // First time showing suggestions, auto-select first
                        newSelected = 0;
                    } else if (prev.selected >= suggestions.length) {
                        // Selection is out of bounds, clamp to last item
                        newSelected = suggestions.length - 1;
                    } else if (prev.selected < 0 && suggestions.length > 0 && autoSelectFirst) {
                        // No selection but we have suggestions
                        newSelected = 0;
                    }
                    
                    return { suggestions, selected: newSelected };
                } else {
                    // Try to preserve selection by key (old behavior)
                    if (prev.selected >= 0 && prev.selected < prev.suggestions.length) {
                        const previousKey = prev.suggestions[prev.selected].key;
                        const newIndex = suggestions.findIndex(s => s.key === previousKey);
                        if (newIndex !== -1) {
                            // Found the same key, keep it selected
                            return { suggestions, selected: newIndex };
                        }
                    }

                    // Key not found or no previous selection, clamp the selection
                    const clampedSelection = Math.min(prev.selected, suggestions.length - 1);
                    return {
                        suggestions,
                        selected: clampedSelection < 0 && suggestions.length > 0 && autoSelectFirst ? 0 : clampedSelection
                    };
                }
            });
        });
    }, [clampSelection, autoSelectFirst, handler]);
    React.useEffect(() => {
        sync.setValue(query);
    }, [query]);

    // If no query return empty suggestions
    if (!query) {
        return [[], -1, moveUp, moveDown] as const;
    }

    // Return state suggestions
    return [state.suggestions, state.selected, moveUp, moveDown] as const;
}