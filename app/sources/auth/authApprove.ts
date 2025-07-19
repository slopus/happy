
import axios from 'axios';
import { encodeBase64 } from "./base64";

const API_ENDPOINT = process.env.EXPO_PUBLIC_API_ENDPOINT || 'https://handy-api.korshakov.org';

export async function authApprove(token: string, publicKey: Uint8Array, answer: Uint8Array) {
    await axios.post(`${API_ENDPOINT}/v1/auth/response`, {
        publicKey: encodeBase64(publicKey),
        response: encodeBase64(answer)
    }, {
        headers: {
            'Authorization': `Bearer ${token}`,
        }
    });
}