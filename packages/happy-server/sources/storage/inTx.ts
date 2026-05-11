import { Prisma } from "@prisma/client";
import { delay } from "@/utils/delay";
import { db } from "@/storage/db";

export type Tx = Prisma.TransactionClient;

const symbol = Symbol();

export function afterTx(tx: Tx, callback: () => void) {
    // NOTE(logical): `afterTx` assumes the transaction client has already been prepared by `inTx()`,
    // which initializes `(tx as any)[symbol] = []`. If `afterTx` is called with a `tx` that did not
    // go through `inTx`'s wrapper (or called before initialization), `callbacks` will be undefined
    // and `.push()` will throw.
    // Suggested hardening: defensively initialize the array here (or scope `afterTx` so it can only
    // be used inside the `inTx` callback).
    // Related: a real-world crash "undefined reading push" was fixed by updating a call site to use
    // the `inTx` wrapper: https://github.com/slopus/happy/commit/0a69c81f
    let callbacks = (tx as any)[symbol] as (() => void)[];
    callbacks.push(callback);
}

export async function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    let counter = 0;
    let wrapped = async (tx: Tx) => {
        (tx as any)[symbol] = [];
        let result = await fn(tx);
        let callbacks = (tx as any)[symbol] as (() => void)[];
        return { result, callbacks };
    }
    while (true) {
        try {
            let result = await db.$transaction(wrapped, { isolationLevel: 'Serializable', timeout: 10000 });
            for (let callback of result.callbacks) {
                try {
                    callback();
                } catch (e) { // Ignore errors in callbacks because they are used mostly for notifications
                    console.error(e);
                }
            }
            return result.result;
        } catch (e) {
            if (e instanceof Prisma.PrismaClientKnownRequestError) {
                if (e.code === 'P2034' && counter < 3) {
                    counter++;
                    await delay(counter * 100);
                    continue;
                }
            }
            throw e;
        }
    }
}