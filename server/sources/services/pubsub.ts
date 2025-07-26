import { EventEmitter } from 'events';

export interface PubSubEvents {
    'update': (accountId: string, update: {
        id: string,
        seq: number,
        body: any,
        createdAt: number
    }) => void;
    'update-ephemeral': (accountId: string, update: { type: 'activity', id: string, active: boolean, activeAt: number, thinking: boolean }) => void;
}

class PubSubService extends EventEmitter {
    emit<K extends keyof PubSubEvents>(event: K, ...args: Parameters<PubSubEvents[K]>): boolean {
        return super.emit(event, ...args);
    }

    on<K extends keyof PubSubEvents>(event: K, listener: PubSubEvents[K]): this {
        return super.on(event, listener);
    }

    off<K extends keyof PubSubEvents>(event: K, listener: PubSubEvents[K]): this {
        return super.off(event, listener);
    }
}

export const pubsub = new PubSubService();