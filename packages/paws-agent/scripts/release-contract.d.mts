export type ReleaseContractInput = {
    tag: string;
    version: string;
    tagSha: string;
    headSha: string;
};

export function validateReleaseContract(input: ReleaseContractInput): {
    version: string;
    distTag: 'next' | 'latest';
};
