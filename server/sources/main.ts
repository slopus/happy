import { startApi } from "@/app/api";
import { log } from "@/utils/log";
import { awaitShutdown } from "@/utils/shutdown";
import { db } from './storage/db';
import { startTimeout } from "./app/timeout";

async function main() {

    //
    // Start
    //

    await db.$connect();
    await startApi();
    startTimeout();

    //
    // Ready
    //

    log('Ready');
    await awaitShutdown();
    log('Shutting down...');
}

main().catch(async (e) => {
    console.error(e);
    await db.$disconnect();
    process.exit(1);
}).then(async () => {
    log('Disconnecting from DB...');
    await db.$disconnect();
});