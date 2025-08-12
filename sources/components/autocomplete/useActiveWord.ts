import * as React from 'react';
import { findActiveWord } from "./findActiveWord";

export function useActiveWord(text: string, selection: { start: number; end: number }, prefixes: string[] = ['@', '/', ':']) {
    return React.useMemo(() => {
        let w = findActiveWord(text, selection, prefixes);
        console.log('🔎 useActiveWord:', JSON.stringify({
            text,
            selection,
            prefixes,
            foundWord: w,
            returning: w?.activeWord || null
        }, null, 2));
        if (w) {
            return w.activeWord;
        }
        return null;
    }, [text, selection.start, selection.end, prefixes]);
}