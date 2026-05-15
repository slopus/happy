import "reflect-metadata";

// Patch crypto.subtle.importKey to normalize base64 → base64url in JWK data.
// privacy-kit uses standard base64 for Ed25519 JWK keys, but Bun (correctly per spec)
// requires base64url. Node.js is lenient about this, Bun is not.
const origImportKey = crypto.subtle.importKey.bind(crypto.subtle);
crypto.subtle.importKey = function (format: any, keyData: any, algorithm: any, extractable: any, keyUsages: any) {
    if (format === 'jwk' && keyData && typeof keyData === 'object') {
        const fixed = { ...keyData };
        for (const field of ['d', 'x', 'y', 'n', 'e', 'p', 'q', 'dp', 'dq', 'qi', 'k']) {
            if (typeof fixed[field] === 'string') {
                fixed[field] = fixed[field].replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            }
        }
        return origImportKey(format, fixed, algorithm, extractable, keyUsages);
    }
    return origImportKey(format, keyData, algorithm, extractable, keyUsages);
} as any;

import * as fs from "fs";
import * as path from "path";
import { createPGlite } from "./storage/pgliteLoader";

const dataDir = process.env.DATA_DIR || "./data";
const pgliteDir = process.env.PGLITE_DIR || path.join(dataDir, "pglite");

export async function runMigrations(opts: { pgliteDir: string; migrationsDir?: string } = { pgliteDir }) {
    const targetPgliteDir = opts.pgliteDir;
    console.log(`Migrating database in ${targetPgliteDir}...`);
    fs.mkdirSync(targetPgliteDir, { recursive: true });

    const pg = createPGlite(targetPgliteDir);

    // Create migrations tracking table
    await pg.exec(`
        CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
            "id" TEXT PRIMARY KEY,
            "migration_name" TEXT NOT NULL UNIQUE,
            "finished_at" TIMESTAMPTZ,
            "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
            "applied_steps_count" INTEGER NOT NULL DEFAULT 0,
            "logs" TEXT
        );
    `);

    // Find migrations directory - explicit arg wins; fall back to defaults.
    let migrationsDirResolved = "";
    const candidates: string[] = [];
    if (opts.migrationsDir) candidates.push(opts.migrationsDir);
    candidates.push(
        path.join(process.cwd(), "prisma", "migrations"),
        path.join(process.cwd(), "packages", "happy-server", "prisma", "migrations"),
        path.join(path.dirname(process.execPath), "prisma", "migrations"),
    );
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            migrationsDirResolved = candidate;
            break;
        }
    }
    if (!migrationsDirResolved) {
        throw new Error(`Could not find prisma/migrations directory. Tried: ${candidates.join(", ")}`);
    }

    // Get all migration directories sorted
    const dirs = fs.readdirSync(migrationsDirResolved)
        .filter(d => fs.statSync(path.join(migrationsDirResolved, d)).isDirectory())
        .sort();

    // Get already applied migrations
    const applied = await pg.query<{ migration_name: string }>(
        `SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL`
    );
    const appliedSet = new Set(applied.rows.map(r => r.migration_name));

    let appliedCount = 0;
    for (const dir of dirs) {
        if (appliedSet.has(dir)) {
            continue;
        }

        const sqlFile = path.join(migrationsDirResolved, dir, "migration.sql");
        if (!fs.existsSync(sqlFile)) {
            continue;
        }

        console.log(`  Applying ${dir}...`);
        const sql = fs.readFileSync(sqlFile, "utf-8");

        try {
            await pg.exec(sql);
            await pg.query(
                `INSERT INTO "_prisma_migrations" ("id", "migration_name", "finished_at", "applied_steps_count") VALUES ($1, $2, now(), 1)`,
                [crypto.randomUUID(), dir]
            );
            appliedCount++;
        } catch (e: any) {
            throw new Error(`Failed to apply ${dir}: ${e.message}`);
        }
    }

    if (appliedCount === 0) {
        console.log("No new migrations to apply.");
    } else {
        console.log(`Applied ${appliedCount} migration(s).`);
    }

    await pg.close();
}

async function serve() {
    // Ensure DB_PROVIDER is set for db.ts
    process.env.DB_PROVIDER = process.env.DB_PROVIDER || "pglite";
    process.env.PGLITE_DIR = process.env.PGLITE_DIR || pgliteDir;

    const masterSecret = process.env.HANDY_MASTER_SECRET;
    if (!masterSecret) {
        throw new Error("HANDY_MASTER_SECRET is required");
    }

    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3005;
    const host = process.env.HOST || "0.0.0.0";
    const staticDir = process.env.HAPPY_STATIC_DIR || undefined;
    let injectHtmlConfig: Record<string, unknown> | undefined;
    if (process.env.HAPPY_INJECT_HTML_CONFIG) {
        try {
            injectHtmlConfig = JSON.parse(process.env.HAPPY_INJECT_HTML_CONFIG);
        } catch {
            // ignore malformed input
        }
    }

    const { startServer } = await import("./index");
    await startServer({
        pgliteDir: process.env.PGLITE_DIR!,
        masterSecret,
        port,
        host,
        staticDir,
        injectHtmlConfig,
    });

    // Block until shutdown so the process stays alive.
    const { awaitShutdown } = await import("./utils/shutdown");
    await awaitShutdown();
}

// CLI — only when this file is invoked directly, not when imported as a library.
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
const isDirectInvocation =
    invokedFile.endsWith("/standalone.ts") ||
    invokedFile.endsWith("/standalone.js") ||
    invokedFile.endsWith("/standalone.mjs") ||
    invokedFile.endsWith("/standalone.cjs") ||
    invokedFile.endsWith("/happy-server");

if (isDirectInvocation) {
    const command = process.argv[2];

    switch (command) {
        case "migrate":
            runMigrations({ pgliteDir }).catch(e => {
                console.error(e);
                process.exit(1);
            });
            break;
        case "serve":
            serve().catch(e => {
                console.error(e);
                process.exit(1);
            });
            break;
        default:
            console.log(`happy-server - portable distribution

Usage:
  happy-server migrate    Apply database migrations
  happy-server serve      Start the server

Environment variables:
  DATA_DIR          Base data directory (default: ./data)
  PGLITE_DIR        PGlite database directory (default: DATA_DIR/pglite)
  DATABASE_URL      PostgreSQL URL (if set, uses external Postgres instead of PGlite)
  REDIS_URL         Redis URL (optional, not required for standalone)
  PORT              Server port (default: 3005)
  HANDY_MASTER_SECRET  Required: master secret for auth/encryption
`);
            process.exit(command === "--help" || command === "-h" ? 0 : 1);
    }
}
