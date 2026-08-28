const INFERENCE_VENDORS = new Set(['openai', 'anthropic', 'gemini']);

interface InferenceTokenRepository {
    findMany: (args: unknown) => Promise<Array<{ vendor: string; token: Uint8Array<ArrayBuffer> }>>;
}

export async function listInferenceTokens(
    accountId: string,
    repository: InferenceTokenRepository,
    decrypt: (path: string[], encrypted: Uint8Array<ArrayBuffer>) => string,
) {
    const records = await repository.findMany({
        where: {
            accountId,
            vendor: { in: Array.from(INFERENCE_VENDORS) },
        },
        select: { vendor: true, token: true },
    });
    return records
        .filter(({ vendor }) => INFERENCE_VENDORS.has(vendor))
        .map(({ vendor, token }) => ({
            vendor,
            token: decrypt(['user', accountId, 'vendors', vendor, 'token'], token),
        }));
}
