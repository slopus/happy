import ignore from 'ignore';
import { z } from 'zod';

const pathSchema = z.string().min(1).max(4096).refine(value => !value.includes('\0')
    && !/^(?:[A-Za-z]:|[\\/])/.test(value) && !value.split(/[\\/]+/).includes('..'));
const coverageSchema = z.object({ schemaVersion: z.literal(1),
    excludedPaths: z.array(pathSchema).max(100_000),
    excludedPatterns: z.array(pathSchema).max(10_000),
}).strict();
const marker = 'saycode-coverage-v1 ';

export function checkpointCoverageTrailer(input: { excludedPaths?: string[]; excludedPatterns?: string[] }): string {
    const coverage = coverageSchema.parse({ schemaVersion: 1,
        excludedPaths: [...new Set(input.excludedPaths ?? [])].sort(),
        excludedPatterns: [...new Set(input.excludedPatterns ?? [])].sort() });
    return marker + Buffer.from(JSON.stringify(coverage)).toString('base64');
}

export function checkpointExclusionMatcher(input: { excludedPaths?: string[]; excludedPatterns?: string[] }): (path: string) => boolean {
    const paths = new Set(input.excludedPaths ?? []);
    const patterns = ignore().add(input.excludedPatterns ?? []);
    return path => paths.has(path) || path.split('/').some((_segment, index, segments) => paths.has(segments.slice(0, index).join('/')))
        || patterns.ignores(path);
}

export function checkpointCoverageMatcher(body: string): ((path: string) => boolean) | null {
    const line = body.split('\n').find(value => value.startsWith(marker));
    if (!line) return null;
    const coverage = coverageSchema.parse(JSON.parse(Buffer.from(line.slice(marker.length), 'base64').toString('utf8')));
    return checkpointExclusionMatcher(coverage);
}
