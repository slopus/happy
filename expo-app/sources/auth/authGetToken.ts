import { authChallenge } from "./authChallenge";
import axios from 'axios';
import { encodeBase64 } from "../encryption/base64";
import { getServerUrl } from "@/sync/serverConfig";
import { Encryption } from "@/sync/encryption/encryption";
import sodium from '@/encryption/libsodium.lib';

const CONTENT_KEY_BINDING_PREFIX = new TextEncoder().encode('Happy content key v1\u0000');

export async function authGetToken(secret: Uint8Array) {
    const API_ENDPOINT = getServerUrl();
    const { challenge, signature, publicKey } = authChallenge(secret);

    const encryption = await Encryption.create(secret);
    const contentPublicKey = encryption.contentDataKey;

    const signingKeyPair = sodium.crypto_sign_seed_keypair(secret);
    const binding = new Uint8Array(CONTENT_KEY_BINDING_PREFIX.length + contentPublicKey.length);
    binding.set(CONTENT_KEY_BINDING_PREFIX, 0);
    binding.set(contentPublicKey, CONTENT_KEY_BINDING_PREFIX.length);
    const contentPublicKeySig = sodium.crypto_sign_detached(binding, signingKeyPair.privateKey);

    const response = await axios.post(`${API_ENDPOINT}/v1/auth`, {
        challenge: encodeBase64(challenge),
        signature: encodeBase64(signature),
        publicKey: encodeBase64(publicKey),
        contentPublicKey: encodeBase64(contentPublicKey),
        contentPublicKeySig: encodeBase64(contentPublicKeySig),
    });
    const data = response.data;
    return data.token;
}
