import { z } from 'zod';

const line = z.string().trim().min(1).max(2048).refine(value => !/[\r\n]/.test(value));
export const GoalDeliveryAgreementSchema = z.object({
    expectedDeliverables: z.array(line).max(30),
    acceptanceCriteria: z.array(line).max(30),
    finalOutputs: z.array(z.object({ name: line, target: line.refine(value => {
        if (/^https?:\/\//i.test(value)) { try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; } }
        return !/^(?:[a-z][a-z0-9+.-]*:|[\\/])/i.test(value) && !value.split(/[\\/]/).includes('..') && !/[<>]/.test(value)
            && !/(?:^|[\\/])index\.md$/i.test(value);
    }) })).max(30),
});
export type GoalDeliveryAgreement = z.infer<typeof GoalDeliveryAgreementSchema>;
/** Normalize transport separators for display; the machine still authorizes real file paths. */
export function relativeGoalDeliveryFile(root: string, path: string): string | undefined {
    const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
    const normalizedPath = path.replace(/\\/g, '/');
    return normalizedPath.startsWith(normalizedRoot + '/') ? normalizedPath.slice(normalizedRoot.length + 1) : undefined;
}
const start = '<!-- paws:delivery:start -->';
const end = '<!-- paws:delivery:end -->';
const blockPattern = /^<!-- paws:delivery:start -->\r?\n([\s\S]*?)^<!-- paws:delivery:end -->[ \t]*$/m;

/** The readable block in the task index is authoritative; surrounding notes stay intact. */
export function readGoalDeliveryAgreement(source: string): GoalDeliveryAgreement | undefined {
    const match = source.match(blockPattern);
    if (!match) { if (source.includes(start) || source.includes(end)) throw new Error('Malformed delivery agreement'); return; }
    const parts: Record<string, string[]> = {};
    let heading = '';
    for (const text of match[1].split(/\r?\n/)) {
        if (text.startsWith('## ')) { heading = text.slice(3); parts[heading] = []; }
        else if (text.startsWith('- ')) parts[heading]?.push(text.slice(2));
    }
    return GoalDeliveryAgreementSchema.parse({
        expectedDeliverables: parts['Expected deliverables'] ?? [], acceptanceCriteria: parts['Acceptance criteria'] ?? [],
        finalOutputs: (parts['Final outputs'] ?? []).map(value => {
            const link = value.match(/^\[([^\]]+)\]\(<([^>]+)>\)$/);
            if (!link) throw new Error('Malformed final output');
            return { name: link[1], target: /^https?:\/\//i.test(link[2]) ? link[2] : decodeURIComponent(link[2]) };
        }),
    });
}

export function writeGoalDeliveryAgreement(source: string, input: GoalDeliveryAgreement): string {
    readGoalDeliveryAgreement(source); // Never append over a broken existing block.
    const value = GoalDeliveryAgreementSchema.parse(input);
    const lines = [start, '## Expected deliverables', ...value.expectedDeliverables.map(text => `- ${text}`), '',
        '## Acceptance criteria', ...value.acceptanceCriteria.map(text => `- ${text}`), '', '## Final outputs',
        ...value.finalOutputs.map(output => {
            const target = /^https?:\/\//i.test(output.target) ? output.target.replace(/[<>\s]/g, char => encodeURIComponent(char))
                : output.target.split('/').map(segment => encodeURIComponent(segment).replace(/[()]/g, char => `%${char.charCodeAt(0).toString(16)}`)).join('/');
            return `- [${output.name.replace(/\[/g, '［').replace(/\]/g, '］')}](<${target}>)`;
        }), end];
    const block = lines.join('\n');
    const updated = blockPattern.test(source) ? source.replace(blockPattern, () => block) : `${source.trimEnd()}\n\n${block}\n`;
    if (new TextEncoder().encode(updated).length > 256 * 1024) throw new Error('Delivery agreement exceeds the task index size limit');
    return updated;
}

export function withoutGoalDeliveryAgreement(source: string): string { return source.replace(blockPattern, ''); }
