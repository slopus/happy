import { Session } from "@/sync/storageTypes";

function robustHash(str: string): number {
    let hash = 5381; // Better initial value
    if (str.length === 0) return hash;

    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) + hash) + char; // hash * 33 + char (djb2 algorithm)
        hash = hash >>> 0; // Ensure unsigned 32-bit integer
    }

    // Additional mixing to improve distribution
    hash ^= hash >>> 16;
    hash *= 0x85ebca6b;
    hash ^= hash >>> 13;
    hash *= 0xc2b2ae35;
    hash ^= hash >>> 16;
    
    return Math.abs(hash >>> 0);
}

export function entityColor(id: string) {
    const colors = [
        '#cc5049', // Red
        '#d67722', // Orange
        '#955cdb', // Purple
        '#40a920', // Green
        '#309eba', // Cyan
        '#368ad1', // Blue
        '#c7508b', // Pink
        '#8b5a2b', // Brown
        '#2d8659', // Forest Green
        '#b85450', // Dark Red
        '#6366f1', // Indigo
        '#a855f7', // Violet
        '#0891b2', // Teal
        '#ea580c', // Dark Orange
        '#dc2626', // Bright Red
        '#059669', // Emerald
        '#7c3aed', // Purple Blue
        '#0284c7', // Sky Blue
        '#e11d48', // Rose
        '#7c2d12', // Dark Brown
    ]
    return colors[robustHash(id) % colors.length];
}

export function entitySessionColor(session: Session) {
    return entityColor((session.metadata?.path || 'unknon').toLowerCase() + '$' + session.metadata?.machineId || 'unknown');
}