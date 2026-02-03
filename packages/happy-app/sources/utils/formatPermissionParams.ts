export function formatPermissionParams(args: any, maxParams: number = 2, maxLength: number = 20): string {
    if (!args || typeof args !== 'object') {
        return String(args);
    }

    const entries = Object.entries(args);
    
    const formatted = entries
        .slice(0, maxParams)
        .map(([key, value]) => {
            let valueStr = String(value);
            if (valueStr.length > maxLength) {
                valueStr = valueStr.substring(0, maxLength - 2) + '..';
            }
            return `${key}: ${valueStr}`;
        });
    
    if (entries.length > maxParams) {
        formatted.push(`+${entries.length - maxParams} more`);
    }
    
    return formatted.join('\n');
}