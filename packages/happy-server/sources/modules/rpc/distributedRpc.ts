import { randomUUID } from "node:crypto";
import { Socket } from "socket.io";
import { getRpcRequestChannel, getRpcResponseChannel } from "@/modules/backplane/backplane";
import { RedisBackplane } from "@/modules/backplane/redisBackplane";
import { log, warn } from "@/utils/log";

const DEFAULT_RPC_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STALE_PROCESS_CHECK_MS = 5_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;
const DEFAULT_HEARTBEAT_TTL_SECONDS = 60;
const RPC_TIMEOUT_ERROR = 'operation has timed out';
const RPC_METHOD_NOT_AVAILABLE_ERROR = 'RPC method not available';

export interface DistributedRpcResponse {
    ok: boolean;
    result?: any;
    error?: string;
}

export interface DistributedRpcRegistryOptions {
    requestTimeoutMs?: number;
    staleProcessCheckMs?: number;
    heartbeatIntervalMs?: number;
    heartbeatTtlSeconds?: number;
}

interface DistributedRpcRequestEnvelope {
    requestId: string;
    userId: string;
    method: string;
    params: any;
    replyChannel: string;
}

interface DistributedRpcResponseEnvelope extends DistributedRpcResponse {
    requestId: string;
}

export function getRpcProcessKey(processId: string): string {
    return `hp:rpc:proc:${processId}`;
}

export function getRpcMethodsKey(userId: string): string {
    return `hp:rpc:methods:${userId}`;
}

export function getRpcRegistrationMember(userId: string, method: string): string {
    return `${userId}:${method}`;
}

export class DistributedRpcRegistry {
    private readonly redis;
    private readonly processId: string;
    private readonly requestChannel: string;
    private readonly requestTimeoutMs: number;
    private readonly staleProcessCheckMs: number;
    private readonly heartbeatIntervalMs: number;
    private readonly heartbeatTtlSeconds: number;
    private readonly registeredMethods = new Map<string, Set<string>>();
    private readonly pendingResponseChannels = new Set<string>();
    private readonly processHeartbeatTimer: NodeJS.Timeout;
    private destroyed = false;

    private constructor(
        private readonly backplane: RedisBackplane,
        private readonly rpcListeners: Map<string, Map<string, Socket>>,
        options: DistributedRpcRegistryOptions,
    ) {
        this.redis = backplane.getRedis();
        this.processId = backplane.getProcessId();
        this.requestChannel = getRpcRequestChannel(this.processId);
        this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_RPC_REQUEST_TIMEOUT_MS;
        this.staleProcessCheckMs = options.staleProcessCheckMs ?? DEFAULT_STALE_PROCESS_CHECK_MS;
        this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
        this.heartbeatTtlSeconds = options.heartbeatTtlSeconds ?? DEFAULT_HEARTBEAT_TTL_SECONDS;

        this.processHeartbeatTimer = setInterval(() => {
            void this.refreshHeartbeat().catch((error) => {
                if (this.destroyed) {
                    return;
                }
                warn({ module: 'websocket-rpc', error, processId: this.processId }, 'Failed to refresh distributed RPC heartbeat');
            });
        }, this.heartbeatIntervalMs);
        this.processHeartbeatTimer.unref?.();
    }

    static async create(
        backplane: RedisBackplane,
        rpcListeners: Map<string, Map<string, Socket>>,
        options: DistributedRpcRegistryOptions = {},
    ): Promise<DistributedRpcRegistry> {
        const registry = new DistributedRpcRegistry(backplane, rpcListeners, options);
        try {
            await backplane.subscribe(registry.requestChannel, (payload) => {
                void registry.handleIncomingRequest(payload);
            });
            return registry;
        } catch (error) {
            clearInterval(registry.processHeartbeatTimer);
            throw error;
        }
    }

    async register(userId: string, method: string): Promise<void> {
        this.assertNotDestroyed();

        this.trackMethod(userId, method);

        const transaction = this.redis.multi();
        transaction.sadd(getRpcProcessKey(this.processId), getRpcRegistrationMember(userId, method));
        transaction.expire(getRpcProcessKey(this.processId), this.heartbeatTtlSeconds);
        transaction.hset(getRpcMethodsKey(userId), method, this.processId);
        await transaction.exec();
    }

    async unregister(userId: string, method: string): Promise<void> {
        this.assertNotDestroyed();

        this.untrackMethod(userId, method);

        const transaction = this.redis.multi();
        transaction.srem(getRpcProcessKey(this.processId), getRpcRegistrationMember(userId, method));
        transaction.hdel(getRpcMethodsKey(userId), method);
        await transaction.exec();
    }

    async call(userId: string, method: string, params: any): Promise<DistributedRpcResponse> {
        this.assertNotDestroyed();

        const targetProcessId = await this.redis.hget(getRpcMethodsKey(userId), method);
        if (!targetProcessId) {
            return {
                ok: false,
                error: RPC_METHOD_NOT_AVAILABLE_ERROR,
            };
        }

        if (targetProcessId === this.processId) {
            await this.cleanupMethodLookup(userId, method);
            return {
                ok: false,
                error: RPC_METHOD_NOT_AVAILABLE_ERROR,
            };
        }

        const requestId = randomUUID();
        const replyChannel = getRpcResponseChannel(requestId);
        this.pendingResponseChannels.add(replyChannel);

        let responseTimer: NodeJS.Timeout | undefined;
        let staleCheckTimer: NodeJS.Timeout | undefined;

        const response = new Promise<DistributedRpcResponse>((resolve) => {
            let settled = false;

            const finalize = async (result: DistributedRpcResponse) => {
                if (settled) {
                    return;
                }
                settled = true;
                if (responseTimer) {
                    clearTimeout(responseTimer);
                }
                if (staleCheckTimer) {
                    clearTimeout(staleCheckTimer);
                }
                this.pendingResponseChannels.delete(replyChannel);
                await this.safeUnsubscribe(replyChannel);
                resolve(result);
            };

            responseTimer = setTimeout(() => {
                void finalize({
                    ok: false,
                    error: RPC_TIMEOUT_ERROR,
                });
            }, this.requestTimeoutMs);
            responseTimer.unref?.();

            staleCheckTimer = setTimeout(() => {
                void this.checkForStaleProcess(targetProcessId, userId, method).then((isStale) => {
                    if (!isStale) {
                        return;
                    }
                    return finalize({
                        ok: false,
                        error: RPC_METHOD_NOT_AVAILABLE_ERROR,
                    });
                }).catch((error) => {
                    warn({ module: 'websocket-rpc', error, processId: targetProcessId, userId, method }, 'Failed to check distributed RPC process liveness');
                });
            }, this.staleProcessCheckMs);
            staleCheckTimer.unref?.();

            const onResponse = (payload: Buffer) => {
                void this.handleResponsePayload(requestId, payload, finalize);
            };

            this.backplane.subscribe(replyChannel, onResponse).then(() => {
                return this.backplane.publish(getRpcRequestChannel(targetProcessId), Buffer.from(JSON.stringify({
                    requestId,
                    userId,
                    method,
                    params,
                    replyChannel,
                } satisfies DistributedRpcRequestEnvelope)));
            }).catch((error) => {
                warn({ module: 'websocket-rpc', error, userId, method, targetProcessId }, 'Failed to dispatch distributed RPC request');
                void finalize({
                    ok: false,
                    error: this.normalizeErrorMessage(error),
                });
            });
        });

        return await response;
    }

    async destroy(): Promise<void> {
        if (this.destroyed) {
            return;
        }

        this.destroyed = true;
        clearInterval(this.processHeartbeatTimer);

        const channelsToUnsubscribe = [this.requestChannel, ...this.pendingResponseChannels];
        this.pendingResponseChannels.clear();
        await Promise.all(channelsToUnsubscribe.map((channel) => this.safeUnsubscribe(channel)));

        const transaction = this.redis.multi();
        transaction.del(getRpcProcessKey(this.processId));
        for (const [userId, methods] of this.registeredMethods.entries()) {
            if (methods.size > 0) {
                transaction.hdel(getRpcMethodsKey(userId), ...methods);
            }
        }
        this.registeredMethods.clear();
        await transaction.exec();
    }

    getProcessId(): string {
        return this.processId;
    }

    private async refreshHeartbeat(): Promise<void> {
        if (this.destroyed) {
            return;
        }
        await this.redis.expire(getRpcProcessKey(this.processId), this.heartbeatTtlSeconds);
    }

    private async handleIncomingRequest(payload: Buffer): Promise<void> {
        let request: DistributedRpcRequestEnvelope;
        try {
            request = JSON.parse(payload.toString()) as DistributedRpcRequestEnvelope;
        } catch (error) {
            warn({ module: 'websocket-rpc', error }, 'Failed to parse distributed RPC request');
            return;
        }

        if (!request || typeof request.userId !== 'string' || typeof request.method !== 'string' || typeof request.replyChannel !== 'string' || typeof request.requestId !== 'string') {
            warn({ module: 'websocket-rpc', request }, 'Received malformed distributed RPC request');
            return;
        }

        const targetSocket = this.rpcListeners.get(request.userId)?.get(request.method);
        if (!targetSocket || !targetSocket.connected) {
            await this.cleanupLocalStaleRegistration(request.userId, request.method);
            await this.publishResponse(request.replyChannel, {
                requestId: request.requestId,
                ok: false,
                error: RPC_METHOD_NOT_AVAILABLE_ERROR,
            });
            return;
        }

        try {
            const result = await targetSocket.timeout(this.requestTimeoutMs).emitWithAck('rpc-request', {
                method: request.method,
                params: request.params,
            });

            await this.publishResponse(request.replyChannel, {
                requestId: request.requestId,
                ok: true,
                result,
            });
        } catch (error) {
            await this.publishResponse(request.replyChannel, {
                requestId: request.requestId,
                ok: false,
                error: this.normalizeErrorMessage(error),
            });
        }
    }

    private async handleResponsePayload(
        requestId: string,
        payload: Buffer,
        finalize: (result: DistributedRpcResponse) => Promise<void>,
    ): Promise<void> {
        let response: DistributedRpcResponseEnvelope;
        try {
            response = JSON.parse(payload.toString()) as DistributedRpcResponseEnvelope;
        } catch (error) {
            warn({ module: 'websocket-rpc', error, requestId }, 'Failed to parse distributed RPC response');
            return;
        }

        if (!response || response.requestId !== requestId || typeof response.ok !== 'boolean') {
            return;
        }

        await finalize({
            ok: response.ok,
            result: response.result,
            error: response.error,
        });
    }

    private async publishResponse(replyChannel: string, response: DistributedRpcResponseEnvelope): Promise<void> {
        try {
            await this.backplane.publish(replyChannel, Buffer.from(JSON.stringify(response)));
        } catch (error) {
            warn({ module: 'websocket-rpc', error, replyChannel }, 'Failed to publish distributed RPC response');
        }
    }

    private async checkForStaleProcess(targetProcessId: string, userId: string, method: string): Promise<boolean> {
        const exists = await this.redis.exists(getRpcProcessKey(targetProcessId));
        if (exists !== 0) {
            return false;
        }

        await this.cleanupMethodLookup(userId, method);
        return true;
    }

    private async cleanupMethodLookup(userId: string, method: string): Promise<void> {
        await this.redis.hdel(getRpcMethodsKey(userId), method);
    }

    private async cleanupLocalStaleRegistration(userId: string, method: string): Promise<void> {
        this.untrackMethod(userId, method);

        const transaction = this.redis.multi();
        transaction.srem(getRpcProcessKey(this.processId), getRpcRegistrationMember(userId, method));
        transaction.hdel(getRpcMethodsKey(userId), method);
        await transaction.exec();
    }

    private async safeUnsubscribe(channel: string): Promise<void> {
        try {
            await this.backplane.unsubscribe(channel);
        } catch (error) {
            if (this.destroyed) {
                return;
            }
            log({ module: 'websocket-rpc', error, channel }, 'Failed to unsubscribe distributed RPC backplane channel');
        }
    }

    private normalizeErrorMessage(error: unknown): string {
        if (error instanceof Error && error.message) {
            return error.message;
        }
        return 'RPC call failed';
    }

    private trackMethod(userId: string, method: string): void {
        let methods = this.registeredMethods.get(userId);
        if (!methods) {
            methods = new Set();
            this.registeredMethods.set(userId, methods);
        }
        methods.add(method);
    }

    private untrackMethod(userId: string, method: string): void {
        const methods = this.registeredMethods.get(userId);
        if (!methods) {
            return;
        }

        methods.delete(method);
        if (methods.size === 0) {
            this.registeredMethods.delete(userId);
        }
    }

    private assertNotDestroyed(): void {
        if (this.destroyed) {
            throw new Error('DistributedRpcRegistry has been destroyed');
        }
    }
}
