export type TerminalOperation =
    | { type: 'reset' }
    | { type: 'write'; data: string }
    | { type: 'focus' }
    | { type: 'fit' }
    | { type: 'setReadOnly'; readOnly: boolean };

export class TerminalOperationQueue {
    private readonly operations: TerminalOperation[] = [];
    private ready = false;
    private draining = false;

    constructor(private readonly execute: (operation: TerminalOperation) => void) {}

    enqueue(operation: TerminalOperation): void {
        this.operations.push(operation);
        this.drain();
    }

    markReady(): void {
        this.ready = true;
        this.drain();
    }

    markNotReady(): void {
        this.ready = false;
    }

    private drain(): void {
        if (!this.ready || this.draining) {
            return;
        }
        this.draining = true;
        try {
            while (this.ready && this.operations.length > 0) {
                this.execute(this.operations.shift()!);
            }
        } finally {
            this.draining = false;
        }
    }
}
