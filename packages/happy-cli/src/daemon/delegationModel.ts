export interface DelegationModelChoice { code: string; name: string; efforts?: readonly string[] }
const normalized = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Resolve only observed catalog entries. Ambiguous labels never select a default. */
export function resolveDelegationModel(requested: string, choices: readonly DelegationModelChoice[]): DelegationModelChoice {
    const exact = choices.filter(choice => choice.code === requested);
    if (exact.length === 1) return exact[0];
    const label = normalized(requested);
    if (!label) throw new Error('A model code or label is required');
    const named = choices.filter(choice => normalized(choice.name) === label || normalized(choice.code) === label);
    if (named.length === 1) return named[0];
    const words = choices.filter(choice => (` ${normalized(choice.name)} `).includes(` ${label} `));
    if (words.length === 1) return words[0];
    throw new Error((named.length || words.length) ? `Model label is ambiguous: ${requested}` : `Model is unavailable in this agent: ${requested}`);
}
