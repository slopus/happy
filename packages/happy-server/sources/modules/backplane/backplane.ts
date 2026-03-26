import { randomUUID } from "node:crypto";

export type BackplaneHandler = (payload: Buffer) => void;

export interface Backplane {
    publish(channel: string, payload: Buffer): Promise<void>;
    subscribe(channel: string, handler: BackplaneHandler): Promise<void>;
    unsubscribe(channel: string): Promise<void>;
    destroy(): Promise<void>;
    isHealthy(): Promise<boolean>;
    getProcessId(): string;
}

export const BACKPLANE_CHANNEL_PREFIX = 'hp';

export function createProcessId(): string {
    return randomUUID();
}

export function getUserUpdatesChannel(userId: string): string {
    return `${BACKPLANE_CHANNEL_PREFIX}:user:${userId}:updates`;
}

export function getUserEphemeralChannel(userId: string): string {
    return `${BACKPLANE_CHANNEL_PREFIX}:user:${userId}:ephemeral`;
}

export function getRpcRequestChannel(processId: string): string {
    return `${BACKPLANE_CHANNEL_PREFIX}:rpc:req:${processId}`;
}

export function getRpcResponseChannel(requestId: string): string {
    return `${BACKPLANE_CHANNEL_PREFIX}:rpc:res:${requestId}`;
}
