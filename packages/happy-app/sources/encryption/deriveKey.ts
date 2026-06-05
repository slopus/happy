import { hmac_sha512 } from "./hmac_sha512";

export type KeyTreeState = {
    key: Uint8Array,
    chainCode: Uint8Array
};

export async function deriveSecretKeyTreeRoot(seed: Uint8Array, usage: string): Promise<KeyTreeState> {
    const I = await hmac_sha512(new TextEncoder().encode(usage + ' Master Seed'), seed);
    return {
        key: I.slice(0, 32),
        chainCode: I.slice(32)
    };
}

export async function deriveSecretKeyTreeChild(chainCode: Uint8Array, index: string): Promise<KeyTreeState> {

    // Prepare data
    const data = new Uint8Array([0x0, ...new TextEncoder().encode(index)]); // prepend 0x00 for separator

    // Derive key
    const I = await hmac_sha512(chainCode, data);
    // Use slice() not subarray() so the returned key/chainCode each own a
    // fresh 32-byte ArrayBuffer. The native libsodium TurboModule on iOS
    // reads the underlying ArrayBuffer length (`.length(runtime)`) when
    // validating crypto_secretbox key bytes — passing a subarray view onto
    // a 64-byte parent buffer makes that check see 64 and reject with
    // "invalid key length", even though the view itself is the right 32
    // bytes. The sibling deriveSecretKeyTreeRoot already does this; keep
    // the two consistent.
    return {
        key: I.slice(0, 32),
        chainCode: I.slice(32),
    };
}

export async function deriveKey(master: Uint8Array, usage: string, path: string[]): Promise<Uint8Array> {
    let state = await deriveSecretKeyTreeRoot(master, usage);
    let remaining = [...path];
    while (remaining.length > 0) {
        let index = remaining[0];
        remaining = remaining.slice(1);
        state = await deriveSecretKeyTreeChild(state.chainCode, index);
    }
    return state.key;
}