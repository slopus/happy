import { authChallenge } from "./authChallenge";
import axios from 'axios';
import { encodeBase64 } from "./base64";

const API_ENDPOINT = process.env.EXPO_PUBLIC_API_ENDPOINT || 'https://handy-api.korshakov.org';

export async function authGetToken(secret: Uint8Array) {
    const { challenge, signature, publicKey } = authChallenge(secret);
    const response = await axios.post(`${API_ENDPOINT}/v1/auth`, { challenge: encodeBase64(challenge), signature: encodeBase64(signature), publicKey: encodeBase64(publicKey) });
    const data = response.data;
    return data.token;
}