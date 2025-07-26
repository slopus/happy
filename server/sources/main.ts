import { startApi } from "@/app/api";
import { log } from "@/utils/log";
import { awaitShutdown, onShutdown } from "@/utils/shutdown";
import { db } from './storage/db';
import { startTimeout } from "./app/timeout";
import { redis } from "./services/redis";

async function main() {

    // Storage
    await db.$connect();
    onShutdown('db', async () => {
        await db.$disconnect();
    });
    await redis.ping();

    //
    // Start
    //

    await startApi();
    startTimeout();

    //
    // Ready
    //

    log('Ready');
    await awaitShutdown();
    log('Shutting down...');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
}).then(() => {
    process.exit(0);
});