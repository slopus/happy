import { authChallenge } from "./authChallenge";
import axios from 'axios';
import { encodeBase64 } from "../encryption/base64";
import { getServerUrl } from "@/sync/serverConfig";

export async function authGetToken(secret: Uint8Array) {
    const API_ENDPOINT = getServerUrl();
    const { challenge, signature, publicKey } = authChallenge(secret);
    const response = await axios.post(`${API_ENDPOINT}/v1/auth`, { challenge: encodeBase64(challenge), signature: encodeBase64(signature), publicKey: encodeBase64(publicKey) });
    const data = response.data;
    return data.token;
}