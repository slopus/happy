export class AbortedExeption extends Error {
    constructor(message: string = "Operation aborted") {
        super(message);
        this.name = "AbortedExeption";

        // This is needed to properly capture the stack trace in TypeScript
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, AbortedExeption);
        }
    }

    static isAborted(error: unknown): boolean {
        return error instanceof AbortedExeption;
    }
}