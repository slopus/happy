export function trimIdent(text: string): string {
    // Split the text into an array of lines
    const lines = text.split('\n');

    // Remove leading and trailing empty lines
    while (lines.length > 0 && lines[0].trim() === '') {
        lines.shift();
    }
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
        lines.pop();
    }

    // Find the minimum number of leading spaces in non-empty lines
    const minSpaces = lines.reduce((min, line) => {
        if (line.trim() === '') {
            return min;
        }
        const leadingSpaces = line.match(/^\s*/)![0].length;
        return Math.min(min, leadingSpaces);
    }, Infinity);

    // Remove the common leading spaces from each line
    const trimmedLines = lines.map(line => line.slice(minSpaces));

    // Join the trimmed lines back into a single string
    return trimmedLines.join('\n');
}