import type { AgentLogger, PawsAgentEvent, PawsAgentEventListener } from './types';

export class PawsAgentEvents {
    private readonly listeners = new Set<PawsAgentEventListener>();

    constructor(private readonly logger?: AgentLogger) {}

    subscribe(listener: PawsAgentEventListener): () => void {
        this.listeners.add(listener);
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            this.listeners.delete(listener);
        };
    }

    emit(event: PawsAgentEvent): void {
        for (const listener of [...this.listeners]) {
            try {
                listener(event);
            } catch {
                this.logger?.error?.('Paws Agent event listener failed');
            }
        }
    }

    clear(): void {
        this.listeners.clear();
    }
}
