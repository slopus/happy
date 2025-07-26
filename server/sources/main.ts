import { startApi } from "@/app/api";
import { log } from "@/utils/log";
import { awaitShutdown } from "@/utils/shutdown";
import { db } from './storage/db';
import { startTimeout } from "./app/timeout";
import { redis } from "./services/redis";

async function main() {

    // Storage
    await db.$connect();
    await redis.ping();

    //
    // Start
    //

    const { app, io } = await startApi();
    startTimeout();

    //
    // Ready
    //

    log('Ready');
    await awaitShutdown();
    log('Shutting down...');
    
    // Close Socket.io connections
    io.close(() => {
        log('Socket.io closed');
    });
    
    // Close Fastify server
    await app.close();
    log('Fastify server closed');
}

main().catch(async (e) => {
    console.error(e);
    await db.$disconnect();
    process.exit(1);
}).then(async () => {
    log('Disconnecting from DB...');
    await db.$disconnect();
});