import { base64UrlEncode, base64UrlEncodeJson, pemToDer, utf8 } from '@/utils/encoding';

export type JwtAlgorithm = 'ES256' | 'RS256';

const importParams: Record<JwtAlgorithm, SubtleCryptoImportKeyAlgorithm> = {
    ES256: { name: 'ECDSA', namedCurve: 'P-256' },
    RS256: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
};

const signParams: Record<JwtAlgorithm, SubtleCryptoSignAlgorithm> = {
    ES256: { name: 'ECDSA', hash: 'SHA-256' },
    RS256: { name: 'RSASSA-PKCS1-v1_5' },
};

// Imported keys are plain values (not request-bound I/O), so they are safe to
// keep for the life of the isolate.
const keyCache = new Map<string, CryptoKey>();

export async function importPkcs8Key(pem: string, alg: JwtAlgorithm): Promise<CryptoKey> {
    const cacheKey = `${alg}:${pem}`;
    const cached = keyCache.get(cacheKey);
    if (cached) {
        return cached;
    }
    const key = await crypto.subtle.importKey('pkcs8', pemToDer(pem), importParams[alg], false, ['sign']);
    keyCache.set(cacheKey, key);
    return key;
}

/**
 * Signs a compact JWS. Web Crypto's ECDSA output is already the raw r||s
 * form JWS requires for ES256, so no DER conversion is needed.
 */
export async function signJwt(
    alg: JwtAlgorithm,
    key: CryptoKey,
    header: Record<string, string>,
    claims: Record<string, string | number>
): Promise<string> {
    const signingInput = `${base64UrlEncodeJson({ alg, ...header })}.${base64UrlEncodeJson(claims)}`;
    const signature = await crypto.subtle.sign(signParams[alg], key, utf8(signingInput));
    return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}
