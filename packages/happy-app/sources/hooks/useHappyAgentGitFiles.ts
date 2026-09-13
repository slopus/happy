import * as React from 'react';
import {
    readHappyAgentGitFile,
    type HappyAgentFileContent,
    type HappyAgentGitFile,
} from '@/sync/happyAgentGit';

export type HappyAgentFileResult =
    | { content: HappyAgentFileContent; error: null }
    | { content: null; error: string };

/** One displayed Git snapshot owns its requested files; the viewer remounts on refresh. */
export function useHappyAgentGitFiles(sessionId: string, base: string, files: HappyAgentGitFile[]) {
    const [requested, setRequested] = React.useState<ReadonlySet<string>>(() => new Set());
    const [results, setResults] = React.useState<ReadonlyMap<string, HappyAgentFileResult>>(() => new Map());
    const inFlight = React.useRef(new Set<string>());
    const generation = React.useRef(0);
    const filesByPath = React.useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);

    React.useEffect(() => {
        generation.current += 1;
        return () => {
            generation.current += 1;
            inFlight.current.clear();
        };
    }, []);

    const requestContent = React.useCallback((path: string) => {
        if (!filesByPath.has(path)) return;
        setRequested((previous) => previous.has(path) ? previous : new Set(previous).add(path));
    }, [filesByPath]);

    React.useEffect(() => {
        const currentGeneration = generation.current;
        for (const path of requested) {
            // Each file reads at most two sides, so at most four RPCs are live.
            if (inFlight.current.size >= 2) break;
            if (results.has(path) || inFlight.current.has(path)) continue;
            const file = filesByPath.get(path);
            if (!file) continue;
            inFlight.current.add(path);

            const finish = (result: HappyAgentFileResult) => {
                if (generation.current !== currentGeneration) return;
                inFlight.current.delete(path);
                setResults((previous) => new Map(previous).set(path, result));
            };
            void readHappyAgentGitFile(sessionId, base, file).then(
                (content) => finish({ content, error: null }),
                (error: unknown) => finish({
                    content: null,
                    error: error instanceof Error ? error.message : 'Could not load this file. Reload changes to try again.',
                }),
            );
        }
    }, [base, filesByPath, requested, results, sessionId]);

    return { results, requestContent };
}