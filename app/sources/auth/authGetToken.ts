import { authChallenge } from "./authChallenge";
import axios from 'axios';
import { encodeBase64 } from "./base64";

export async function authGetToken(secret: Uint8Array) {
    const { challenge, signature, publicKey } = authChallenge(secret);
    const response = await axios.post('https://handy-api.korshakov.org/v1/auth', { challenge: encodeBase64(challenge), signature: encodeBase64(signature), publicKey: encodeBase64(publicKey) });
    const data = response.data;
    return data.token;
}