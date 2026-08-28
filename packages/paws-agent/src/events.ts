type EventListener = (...args: any[]) => void;

/** A small EventEmitter-compatible surface that works in Node and browsers. */
export class PawsEventEmitter {
    private readonly listeners = new Map<string | symbol, Set<EventListener>>();

    on(event: string | symbol, listener: EventListener): this {
        const eventListeners = this.listeners.get(event) ?? new Set<EventListener>();
        eventListeners.add(listener);
        this.listeners.set(event, eventListeners);
        return this;
    }

    once(event: string | symbol, listener: EventListener): this {
        const wrapped: EventListener = (...args) => {
            this.off(event, wrapped);
            listener(...args);
        };
        return this.on(event, wrapped);
    }

    off(event: string | symbol, listener: EventListener): this {
        const eventListeners = this.listeners.get(event);
        eventListeners?.delete(listener);
        if (eventListeners?.size === 0) {
            this.listeners.delete(event);
        }
        return this;
    }

    removeListener(event: string | symbol, listener: EventListener): this {
        return this.off(event, listener);
    }

    removeAllListeners(event?: string | symbol): this {
        if (event === undefined) {
            this.listeners.clear();
        } else {
            this.listeners.delete(event);
        }
        return this;
    }

    emit(event: string | symbol, ...args: any[]): boolean {
        const eventListeners = this.listeners.get(event);
        if (!eventListeners?.size) {
            return false;
        }
        for (const listener of [...eventListeners]) {
            listener(...args);
        }
        return true;
    }
}
