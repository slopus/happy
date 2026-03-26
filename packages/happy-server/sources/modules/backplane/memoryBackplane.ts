import { EventEmitter } from "node:events";
import { Backplane, BackplaneHandler, createProcessId } from "./backplane";

const sharedEmitter = new EventEmitter();
sharedEmitter.setMaxListeners(0);

export class MemoryBackplane implements Backplane {
    private readonly processId = createProcessId();
    private readonly subscriptions = new Map<string, BackplaneHandler>();
    private destroyed = false;

    async publish(channel: string, payload: Buffer): Promise<void> {
        this.assertNotDestroyed();
        sharedEmitter.emit(channel, Buffer.from(payload));
    }

    async subscribe(channel: string, handler: BackplaneHandler): Promise<void> {
        this.assertNotDestroyed();

        const existingHandler = this.subscriptions.get(channel);
        if (existingHandler) {
            sharedEmitter.off(channel, existingHandler);
        }

        const wrappedHandler: BackplaneHandler = (payload) => {
            handler(Buffer.from(payload));
        };

        this.subscriptions.set(channel, wrappedHandler);
        sharedEmitter.on(channel, wrappedHandler);
    }

    async unsubscribe(channel: string): Promise<void> {
        const handler = this.subscriptions.get(channel);
        if (!handler) {
            return;
        }

        sharedEmitter.off(channel, handler);
        this.subscriptions.delete(channel);
    }

    async destroy(): Promise<void> {
        if (this.destroyed) {
            return;
        }

        for (const [channel, handler] of this.subscriptions) {
            sharedEmitter.off(channel, handler);
        }
        this.subscriptions.clear();
        this.destroyed = true;
    }

    async isHealthy(): Promise<boolean> {
        return !this.destroyed;
    }

    getProcessId(): string {
        return this.processId;
    }

    private assertNotDestroyed(): void {
        if (this.destroyed) {
            throw new Error('Backplane has been destroyed');
        }
    }
}
