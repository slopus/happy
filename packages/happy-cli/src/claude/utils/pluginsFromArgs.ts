import { resolve } from 'node:path';
import type { QueryOptions } from '../sdk';

/** Map only explicit plugin directories; other CLI flags must not override SDK safeguards. */
export function pluginsFromArgs(args: string[] = [], cwd: string): QueryOptions['plugins'] {
    const plugins: NonNullable<QueryOptions['plugins']> = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') break;
        let path: string;
        if (arg === '--plugin-dir') {
            const next = args[++i];
            if (!next || next.startsWith('-')) {
                throw new Error('--plugin-dir requires a path');
            }
            path = next;
        } else if (arg.startsWith('--plugin-dir=')) {
            path = arg.slice('--plugin-dir='.length);
        } else {
            continue;
        }
        if (!path || path.includes('\0')) {
            throw new Error('--plugin-dir requires a non-empty path without null bytes');
        }
        // Remote startup may run in a daemon whose cwd differs from the session's.
        plugins.push({ type: 'local', path: resolve(cwd, path) });
    }
    return plugins.length > 0 ? plugins : undefined;
}