import axios from 'axios';
import { encodeBase64 } from "./base64";
import { getServerUrl } from "@/sync/serverConfig";

export async function authAccountApprove(token: string, publicKey: Uint8Array, answer: Uint8Array) {
    const API_ENDPOINT = getServerUrl();
    await axios.post(`${API_ENDPOINT}/v1/auth/account/response`, {
        publicKey: encodeBase64(publicKey),
        response: encodeBase64(answer)
    }, {
        headers: {
            'Authorization': `Bearer ${token}`,
        }
    });
}