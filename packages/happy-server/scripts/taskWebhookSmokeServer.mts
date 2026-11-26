import { runMigrations } from '../sources/standalone';
await runMigrations({ pgliteDir: process.env.PGLITE_DIR! });
const { startServer } = await import('../sources/index');
await startServer({ pgliteDir: process.env.PGLITE_DIR!, masterSecret: process.env.HANDY_MASTER_SECRET!, host: '127.0.0.1', port: Number(process.env.PORT) });
console.log('WEBHOOK_TEST_SERVER_READY');
