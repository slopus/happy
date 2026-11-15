import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { defineConfig } from "prisma/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const rootEnv = path.resolve(here, "../../.env");
if (existsSync(rootEnv)) config({ path: rootEnv });
config();

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    // The migrate command passes a copy without the deferred migrations it holds back.
    path: process.env.RAKAZO_MIGRATIONS_PATH || "prisma/migrations",
  },
  datasource: {
    // Migrations run as the owner role; DATABASE_URL may be the app's runtime login.
    url:
      process.env.DATABASE_MIGRATION_URL ||
      process.env.DATABASE_URL ||
      "postgres://rakazo:rakazo@127.0.0.1:5433/rakazo",
  },
});
