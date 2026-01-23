import { delay } from "@/utils/delay";
import { db } from "@/storage/db";
import { isPrismaErrorCode, type TransactionClient } from "@/storage/prisma";

export type Tx = TransactionClient;

const symbol = Symbol();

export function afterTx(tx: Tx, callback: () => void) {
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
            if (isPrismaErrorCode(e, "P2034") && counter < 3) {
                counter++;
                await delay(counter * 100);
                continue;
            }
            throw e;
        }
    }
}
