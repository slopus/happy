import { diffLines, diffWordsWithSpace, diffChars } from 'diff';

export interface DiffToken {
    value: string;
    added?: boolean;
    removed?: boolean;
}

export interface DiffLine {
    type: 'add' | 'remove' | 'normal';
    content: string;
    oldLineNumber?: number;
    newLineNumber?: number;
    tokens?: DiffToken[]; // For inline highlighting
}

export interface DiffHunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: DiffLine[];
}

export interface DiffResult {
    hunks: DiffHunk[];
    stats: {
        additions: number;
        deletions: number;
    };
}

interface LinePair {
    oldLine?: string;
    newLine?: string;
    oldIndex?: number;
    newIndex?: number;
}

/**
 * Calculate unified diff with inline highlighting
 * Similar to git diff algorithm
 */
export function calculateUnifiedDiff(
    oldText: string,
    newText: string,
    contextLines: number = 3
): DiffResult {
    // First, get line-level changes
    const lineChanges = diffLines(oldText, newText);
    
    // Convert to our internal format and track line numbers
    const allLines: DiffLine[] = [];
    const linePairs: LinePair[] = [];
    let oldLineNum = 1;
    let newLineNum = 1;
    let additions = 0;
    let deletions = 0;
    
    // First pass: identify all lines and potential pairs
    let pendingRemovals: { line: string; lineNum: number; index: number }[] = [];
    
    lineChanges.forEach((change) => {
        const lines = change.value.split('\n').filter((line, index, arr) =>
            !(index === arr.length - 1 && line === '')
        );
        
        lines.forEach((line) => {
            if (change.removed) {
                pendingRemovals.push({
                    line,
                    lineNum: oldLineNum,
                    index: allLines.length
                });
                allLines.push({
                    type: 'remove',
                    content: line,
                    oldLineNumber: oldLineNum++,
                });
                deletions++;
            } else if (change.added) {
                // Try to pair with a removal for inline diff
                let paired = false;
                if (pendingRemovals.length > 0) {
                    // Find best matching removal (simple heuristic: first one with some similarity)
                    const removalIndex = findBestMatch(line, pendingRemovals.map(r => r.line));
                    if (removalIndex !== -1) {
                        const removal = pendingRemovals[removalIndex];
                        pendingRemovals.splice(removalIndex, 1);
                        
                        // Calculate inline diff
                        const tokens = calculateInlineDiff(removal.line, line);
                        
                        // Update the removal line with tokens
                        allLines[removal.index].tokens = tokens.filter(t => !t.added);
                        
                        // Add the addition line with tokens
                        allLines.push({
                            type: 'add',
                            content: line,
                            newLineNumber: newLineNum++,
                            tokens: tokens.filter(t => !t.removed)
                        });
                        
                        paired = true;
                    }
                }
                
                if (!paired) {
                    allLines.push({
                        type: 'add',
                        content: line,
                        newLineNumber: newLineNum++,
                    });
                }
                additions++;
            } else {
                // Context line
                allLines.push({
                    type: 'normal',
                    content: line,
                    oldLineNumber: oldLineNum++,
                    newLineNumber: newLineNum++,
                });
            }
        });
    });
    
    // Create hunks with context
    const hunks = createHunks(allLines, contextLines);
    
    return {
        hunks,
        stats: { additions, deletions }
    };
}

/**
 * Calculate inline diff between two lines
 */
function calculateInlineDiff(oldLine: string, newLine: string): DiffToken[] {
    // Use word-level diff for better readability
    const wordDiff = diffWordsWithSpace(oldLine, newLine);
    
    return wordDiff.map(part => ({
        value: part.value,
        added: part.added,
        removed: part.removed
    }));
}

/**
 * Find best matching line from candidates
 * Returns index of best match or -1 if no good match
 */
function findBestMatch(target: string, candidates: string[]): number {
    if (candidates.length === 0) return -1;
    
    let bestIndex = -1;
    let bestScore = 0;
    const threshold = 0.3; // Minimum 30% similarity
    
    candidates.forEach((candidate, index) => {
        const score = calculateSimilarity(target, candidate);
        if (score > bestScore && score > threshold) {
            bestScore = score;
            bestIndex = index;
        }
    });
    
    return bestIndex;
}

/**
 * Calculate similarity between two strings (0-1)
 */
function calculateSimilarity(str1: string, str2: string): number {
    if (str1 === str2) return 1;
    if (!str1 || !str2) return 0;
    
    // Simple character-based similarity
    const chars1 = str1.split('');
    const chars2 = str2.split('');
    const maxLen = Math.max(chars1.length, chars2.length);
    
    if (maxLen === 0) return 1;
    
    let matches = 0;
    const minLen = Math.min(chars1.length, chars2.length);
    
    for (let i = 0; i < minLen; i++) {
        if (chars1[i] === chars2[i]) matches++;
    }
    
    // Also check for common substrings
    const commonSubstrings = findCommonSubstrings(str1, str2);
    const substringBonus = commonSubstrings.reduce((sum, sub) => sum + sub.length, 0) / maxLen;
    
    return (matches / maxLen + substringBonus) / 2;
}

/**
 * Find common substrings between two strings
 */
function findCommonSubstrings(str1: string, str2: string): string[] {
    const minLength = 3; // Minimum substring length
    const substrings: string[] = [];
    
    for (let len = Math.min(str1.length, str2.length); len >= minLength; len--) {
        for (let i = 0; i <= str1.length - len; i++) {
            const sub = str1.substring(i, i + len);
            if (str2.includes(sub) && !substrings.some(s => s.includes(sub))) {
                substrings.push(sub);
            }
        }
    }
    
    return substrings;
}

/**
 * Create hunks with context lines
 */
function createHunks(lines: DiffLine[], contextLines: number): DiffHunk[] {
    const hunks: DiffHunk[] = [];
    const changes = lines.map((line, index) => ({ ...line, index }))
        .filter(line => line.type !== 'normal');
    
    if (changes.length === 0) {
        // No changes, return single hunk with all lines if they exist
        if (lines.length > 0) {
            hunks.push({
                oldStart: 1,
                oldLines: lines.filter(l => l.oldLineNumber).length,
                newStart: 1,
                newLines: lines.filter(l => l.newLineNumber).length,
                lines: lines,
            });
        }
        return hunks;
    }
    
    // Group changes into hunks with context
    let currentHunk: DiffLine[] = [];
    let lastIncludedIndex = -1;
    
    changes.forEach((change, i) => {
        const startContext = Math.max(0, change.index - contextLines);
        const endContext = Math.min(lines.length - 1, change.index + contextLines);
        
        // Add lines from last included index to current hunk
        for (let j = Math.max(lastIncludedIndex + 1, startContext); j <= endContext; j++) {
            currentHunk.push(lines[j]);
        }
        lastIncludedIndex = endContext;
        
        // Check if we should start a new hunk
        const nextChange = changes[i + 1];
        if (nextChange && nextChange.index - endContext > contextLines * 2) {
            // Finish current hunk
            if (currentHunk.length > 0) {
                const firstLine = currentHunk[0];
                hunks.push({
                    oldStart: firstLine.oldLineNumber || 1,
                    oldLines: currentHunk.filter(l => l.oldLineNumber).length,
                    newStart: firstLine.newLineNumber || 1,
                    newLines: currentHunk.filter(l => l.newLineNumber).length,
                    lines: currentHunk,
                });
            }
            currentHunk = [];
        }
    });
    
    // Add remaining lines to last hunk
    if (currentHunk.length > 0) {
        const firstLine = currentHunk[0];
        hunks.push({
            oldStart: firstLine.oldLineNumber || 1,
            oldLines: currentHunk.filter(l => l.oldLineNumber).length,
            newStart: firstLine.newLineNumber || 1,
            newLines: currentHunk.filter(l => l.newLineNumber).length,
            lines: currentHunk,
        });
    }
    
    return hunks;
}

/**
 * Export additional utilities
 */
export function getDiffStats(oldText: string, newText: string): { additions: number; deletions: number } {
    const result = calculateUnifiedDiff(oldText, newText);
    return result.stats;
}