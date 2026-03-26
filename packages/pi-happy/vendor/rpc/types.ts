export type RpcHandler<TRequest = unknown, TResponse = unknown> = (
  data: TRequest,
) => TResponse | Promise<TResponse>;

export type RpcHandlerMap = Map<string, RpcHandler>;

export interface RpcRequest {
  method: string;
  params: string;
}

export interface RpcHandlerConfig {
  scopePrefix: string;
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
  logger?: (message: string, data?: unknown) => void;
}

export type RpcHandlerResult<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: string };
