import type { Socket } from 'socket.io-client';
import { decodeBase64, decrypt, encodeBase64, encrypt } from 'happy-agent/encryption';

import { logger as defaultLogger } from '../logger';
import type { RpcHandler, RpcHandlerConfig, RpcHandlerMap, RpcRequest } from './types';

export class RpcHandlerManager {
  private handlers: RpcHandlerMap = new Map();
  private readonly scopePrefix: string;
  private readonly encryptionKey: Uint8Array;
  private readonly encryptionVariant: 'legacy' | 'dataKey';
  private readonly logger: (message: string, data?: unknown) => void;
  private socket: Socket | null = null;

  constructor(config: RpcHandlerConfig) {
    this.scopePrefix = config.scopePrefix;
    this.encryptionKey = config.encryptionKey;
    this.encryptionVariant = config.encryptionVariant;
    this.logger = config.logger ?? ((message, data) => defaultLogger.debug(message, data));
  }

  registerHandler<TRequest = unknown, TResponse = unknown>(
    method: string,
    handler: RpcHandler<TRequest, TResponse>,
  ): void {
    const prefixedMethod = this.getPrefixedMethod(method);
    this.handlers.set(prefixedMethod, handler as RpcHandler);

    if (this.socket) {
      this.socket.emit('rpc-register', { method: prefixedMethod });
    }
  }

  unregisterHandler(method: string): void {
    const prefixedMethod = this.getPrefixedMethod(method);
    this.handlers.delete(prefixedMethod);

    if (this.socket) {
      this.socket.emit('rpc-unregister', { method: prefixedMethod });
    }
  }

  async handleRequest(request: RpcRequest): Promise<string> {
    try {
      const handler = this.handlers.get(request.method);
      if (!handler) {
        this.logger('[RPC] [ERROR] Method not found', { method: request.method });
        return encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, { error: 'Method not found' }));
      }

      const decryptedParams = decrypt(
        this.encryptionKey,
        this.encryptionVariant,
        decodeBase64(request.params),
      );

      this.logger('[RPC] Calling handler', { method: request.method });
      const result = await handler(decryptedParams);
      this.logger('[RPC] Handler returned', { method: request.method, hasResult: result !== undefined });

      const encryptedResponse = encodeBase64(
        encrypt(this.encryptionKey, this.encryptionVariant, result),
      );
      this.logger('[RPC] Sending encrypted response', {
        method: request.method,
        responseLength: encryptedResponse.length,
      });
      return encryptedResponse;
    } catch (error) {
      this.logger('[RPC] [ERROR] Error handling request', { error });
      return encodeBase64(
        encrypt(this.encryptionKey, this.encryptionVariant, {
          error: error instanceof Error ? error.message : 'Unknown error',
        }),
      );
    }
  }

  onSocketConnect(socket: Socket): void {
    this.socket = socket;
    for (const [prefixedMethod] of this.handlers) {
      socket.emit('rpc-register', { method: prefixedMethod });
    }
  }

  onSocketDisconnect(): void {
    this.socket = null;
  }

  getHandlerCount(): number {
    return this.handlers.size;
  }

  hasHandler(method: string): boolean {
    return this.handlers.has(this.getPrefixedMethod(method));
  }

  clearHandlers(): void {
    this.handlers.clear();
    this.logger('Cleared all RPC handlers');
  }

  private getPrefixedMethod(method: string): string {
    return `${this.scopePrefix}:${method}`;
  }
}

export function createRpcHandlerManager(config: RpcHandlerConfig): RpcHandlerManager {
  return new RpcHandlerManager(config);
}
