import { authChallenge } from "./authChallenge";
import axios from 'axios';
import { encodeBase64 } from "../encryption/base64";
import { getServerUrl } from "@/sync/serverConfig";
import { getHappyClientId } from "@/sync/apiSocket";
import { log } from "@/log";
import { describeNetworkError } from "@/utils/networkDiagnostics";

export async function authGetToken(secret: Uint8Array) {
    const API_ENDPOINT = getServerUrl();
    const { challenge, signature, publicKey } = authChallenge(secret);
    log.log(`[AUTH] POST ${API_ENDPOINT}/v1/auth challengeBytes=${challenge.length} signatureBytes=${signature.length} publicKeyBytes=${publicKey.length}`);
    try {
        const response = await axios.post(`${API_ENDPOINT}/v1/auth`, { challenge: encodeBase64(challenge), signature: encodeBase64(signature), publicKey: encodeBase64(publicKey) }, {
            timeout: 15000,
            headers: {
                'X-Happy-Client': getHappyClientId(),
            }
        });
        const data = response.data;
        log.log(`[AUTH] response status=${response.status} token=${typeof data?.token === 'string' ? 'present' : 'missing'}`);
        return data.token;
    } catch (error) {
        log.log(`[AUTH] failed ${describeNetworkError(error)}`);
        throw error;
    }
}
