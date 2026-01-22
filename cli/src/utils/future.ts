export class Future<T> {
    private _resolve!: (value: T) => void;
    private _reject!: (reason?: any) => void;
    private _promise: Promise<T>;

    constructor() {
        this._promise = new Promise((resolve, reject) => {
            this._resolve = resolve;
            this._reject = reject;
        });
    }

    resolve(value: T) {
        this._resolve(value);
    }

    reject(reason?: any) {
        this._reject(reason);
    }

    get promise() {
        return this._promise;
    }
}