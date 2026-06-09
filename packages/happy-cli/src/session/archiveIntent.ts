export function shouldPostArchiveEndpoint(opts: { archive?: boolean }): boolean {
    return opts.archive ?? true;
}
