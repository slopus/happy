import type { Session } from '@/sync/storageTypes';

export function getRecentPathsForMachine(params: {
    machineId: string;
    recentMachinePaths: Array<{ machineId: string; path: string }>;
    sessions: Array<Session | string> | null | undefined;
}): string[] {
    const paths: string[] = [];
    const pathSet = new Set<string>();

    // First, add paths from recentMachinePaths (most recent first by storage order)
    for (const entry of params.recentMachinePaths) {
        if (entry.machineId === params.machineId && !pathSet.has(entry.path)) {
            paths.push(entry.path);
            pathSet.add(entry.path);
        }
    }

    // Then add paths from sessions if we need more
    if (params.sessions) {
        const pathsWithTimestamps: Array<{ path: string; timestamp: number }> = [];

        params.sessions.forEach((item) => {
            if (typeof item === 'string') return;
            const session = item;
            if (session.metadata?.machineId === params.machineId && session.metadata?.path) {
                const path = session.metadata.path;
                if (!pathSet.has(path)) {
                    pathSet.add(path);
                    pathsWithTimestamps.push({
                        path,
                        timestamp: session.updatedAt || session.createdAt,
                    });
                }
            }
        });

        pathsWithTimestamps
            .sort((a, b) => b.timestamp - a.timestamp)
            .forEach((item) => paths.push(item.path));
    }

    return paths;
}

