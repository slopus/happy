export interface ParsedLine {
    lineNumber: number;
    text: string;
}

/**
 * Parses a string containing line numbers in the format "   123→text content"
 * into an array of line number and text pairs.
 * 
 * @param content - The string content with line numbers
 * @returns Array of parsed lines with line numbers and text
 */
export function parseLineNumbers(content: string): ParsedLine[] {
    if (!content) return [];
    
    const lines = content.split('\n');
    const parsedLines: ParsedLine[] = [];
    
    // Regex to match line number format: optional spaces + number + arrow + text
    // Matches patterns like "   123→text" or "1→text"
    const lineNumberRegex = /^(\s*)(\d+)→(.*)$/;
    
    for (const line of lines) {
        const match = line.match(lineNumberRegex);
        
        if (match) {
            const lineNumber = parseInt(match[2], 10);
            const text = match[3];
            
            parsedLines.push({
                lineNumber,
                text
            });
        }
        // Skip lines that don't match the line number format
        // This prevents empty lines from being appended to previous lines
    }
    
    return parsedLines;
}

/**
 * Formats parsed lines back into the original format with line numbers
 * 
 * @param parsedLines - Array of parsed lines
 * @param padding - Number of spaces to pad line numbers (default: 6)
 * @returns Formatted string with line numbers
 */
export function formatLineNumbers(parsedLines: ParsedLine[], padding: number = 6): string {
    return parsedLines
        .map(({ lineNumber, text }) => {
            const paddedNumber = lineNumber.toString().padStart(padding, ' ');
            return `${paddedNumber}→${text}`;
        })
        .join('\n');
}

/**
 * Extracts just the text content without line numbers
 * 
 * @param content - The string content with line numbers
 * @returns String with just the text content
 */
export function stripLineNumbers(content: string): string {
    const parsedLines = parseLineNumbers(content);
    return parsedLines.map(line => line.text).join('\n');
}