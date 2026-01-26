export class CapabilityError extends Error {
    public readonly code?: string;

    constructor(message: string, code?: string) {
        super(message);
        this.name = 'CapabilityError';
        this.code = code;
    }
}

