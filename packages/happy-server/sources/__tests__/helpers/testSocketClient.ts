import { setTimeout as delay } from "node:timers/promises";
import { io, Socket } from "socket.io-client";
import { auth } from "@/app/auth/auth";

export type TestSocketClientType = 'session-scoped' | 'user-scoped' | 'machine-scoped';

export interface TestSocketClientOptions {
    port: number;
    userId: string;
    token?: string;
    clientType?: TestSocketClientType;
    sessionId?: string;
    machineId?: string;
    timeoutMs?: number;
}

type Waiter = {
    predicate: (payload: any) => boolean;
    resolve: (payload: any) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
};

export class TestSocketClient {
    readonly socket: Socket;
    readonly token: string;
    private readonly recordedEvents = new Map<string, any[]>();
    private readonly waiters = new Map<string, Waiter[]>();

    constructor(socket: Socket, token: string) {
        this.socket = socket;
        this.token = token;

        for (const eventName of ['update', 'ephemeral', 'rpc-registered', 'rpc-unregistered', 'rpc-error', 'error', 'disconnect']) {
            this.socket.on(eventName, (payload: any) => {
                this.recordEvent(eventName, payload);
            });
        }
    }

    getEvents<T = any>(eventName: string): T[] {
        return [...(this.recordedEvents.get(eventName) ?? [])] as T[];
    }

    clearEvents(eventName?: string): void {
        if (eventName) {
            this.recordedEvents.delete(eventName);
            return;
        }
        this.recordedEvents.clear();
    }

    async waitForEvent<T = any>(eventName: string, predicate: (payload: T) => boolean = () => true, timeoutMs = 5_000): Promise<T> {
        const existingEvents = this.recordedEvents.get(eventName) ?? [];
        const existingMatch = existingEvents.find((payload) => predicate(payload));
        if (existingMatch !== undefined) {
            return existingMatch as T;
        }

        return await new Promise<T>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.removeWaiter(eventName, waiter);
                reject(new Error(`Timed out waiting for ${eventName} event`));
            }, timeoutMs);
            timeout.unref?.();

            const waiter: Waiter = {
                predicate: predicate as (payload: any) => boolean,
                resolve: (payload) => resolve(payload as T),
                reject,
                timeout,
            };

            const waiters = this.waiters.get(eventName) ?? [];
            waiters.push(waiter);
            this.waiters.set(eventName, waiters);
        });
    }

    async emitWithAck<T = any>(eventName: string, payload: any, timeoutMs = 5_000): Promise<T> {
        return await new Promise<T>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`Timed out waiting for ack from ${eventName}`));
            }, timeoutMs);
            timeout.unref?.();

            this.socket.emit(eventName, payload, (response: T) => {
                clearTimeout(timeout);
                resolve(response);
            });
        });
    }

    async disconnect(): Promise<void> {
        if (!this.socket.connected) {
            this.socket.close();
            return;
        }

        this.socket.disconnect();
        await delay(50);
        this.socket.close();
    }

    private recordEvent(eventName: string, payload: any): void {
        const events = this.recordedEvents.get(eventName) ?? [];
        events.push(payload);
        this.recordedEvents.set(eventName, events);

        const waiters = this.waiters.get(eventName);
        if (!waiters || waiters.length === 0) {
            return;
        }

        for (const waiter of [...waiters]) {
            if (!waiter.predicate(payload)) {
                continue;
            }
            clearTimeout(waiter.timeout);
            this.removeWaiter(eventName, waiter);
            waiter.resolve(payload);
            break;
        }
    }

    private removeWaiter(eventName: string, waiter: Waiter): void {
        const waiters = this.waiters.get(eventName);
        if (!waiters) {
            return;
        }

        const index = waiters.indexOf(waiter);
        if (index !== -1) {
            waiters.splice(index, 1);
        }

        if (waiters.length === 0) {
            this.waiters.delete(eventName);
        }
    }
}

export async function createTestSocketClient(options: TestSocketClientOptions): Promise<TestSocketClient> {
    await auth.init();

    const token = options.token ?? await auth.createToken(options.userId);
    const clientType = options.clientType ?? 'user-scoped';
    const timeoutMs = options.timeoutMs ?? 5_000;

    const socket = io(`http://127.0.0.1:${options.port}`, {
        path: '/v1/updates',
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
        timeout: timeoutMs,
        auth: {
            token,
            clientType,
            sessionId: options.sessionId,
            machineId: options.machineId,
        },
    });

    await new Promise<void>((resolve, reject) => {
        const onConnect = () => {
            cleanup();
            resolve();
        };
        const onConnectError = (error: Error) => {
            cleanup();
            reject(error);
        };
        const onError = (payload: { message?: string }) => {
            cleanup();
            reject(new Error(payload?.message || 'Socket connection failed'));
        };
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error(`Timed out connecting websocket client to port ${options.port}`));
        }, timeoutMs);
        timeout.unref?.();

        const cleanup = () => {
            clearTimeout(timeout);
            socket.off('connect', onConnect);
            socket.off('connect_error', onConnectError);
            socket.off('error', onError);
        };

        socket.once('connect', onConnect);
        socket.once('connect_error', onConnectError);
        socket.once('error', onError);
    });

    return new TestSocketClient(socket, token);
}
