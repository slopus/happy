/**
 * Minimal RPC wrapper for operations not handled by MobileApiClient
 * This wraps the socket from MobileApiClient to provide RPC functionality
 */

import { encrypt, decrypt, encodeBase64, decodeBase64 } from '@happy/api-client';

class ApiSocketRpc {
    private socket: any = null;
    private secret: Uint8Array | null = null;

    initialize(socket: any, secret: Uint8Array) {
        this.socket = socket;
        this.secret = secret;
    }

    /**
     * RPC call for session/machine operations
     * @param listenerId sessionId or machineId
     * @param method RPC method name
     * @param params Parameters for the RPC call
     */
    async rpc<R, A>(listenerId: string, method: string, params: A): Promise<R> {
        if (!this.socket || !this.secret) {
            throw new Error('ApiSocketRpc not initialized');
        }

        // Encrypt params to base64 string (matching original apiSocket behavior)
        const encryptedParams = encodeBase64(encrypt(params, this.secret));
        
        const result = await this.socket.emitWithAck('rpc-call', {
            method: `${listenerId}:${method}`,
            params: encryptedParams
        });
        
        if (result.ok) {
            // Decrypt result from base64 string
            return decrypt(decodeBase64(result.result), this.secret) as R;
        }
        
        throw new Error('RPC call failed');
    }
}

export const apiSocketRpc = new ApiSocketRpc();