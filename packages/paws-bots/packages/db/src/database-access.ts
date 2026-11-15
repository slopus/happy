import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { Client, escapeIdentifier, escapeLiteral } from "pg";
import type { PrismaClient } from "./generated/prisma/client.js";
import { rlsBypassKey, runAsSystem } from "./row-security.js";

/**
 * NOLOGIN group role created by the row-level security migration. It holds the
 * runtime grants; the login in DATABASE_URL is this role or a member of it.
 */
export const RUNTIME_ROLE = "rakazo_app";

export interface DatabaseUrls {
  /** What the API and worker connect with. */
  url: string;
  /** What migrations run with: DATABASE_MIGRATION_URL, else DATABASE_URL. */
  migrationUrl: string;
  /** False when migrations and the app share one login, so policies are bypassed. */
  separate: boolean;
}

export function databaseUrls(env: Record<string, string | undefined>): DatabaseUrls {
  const url = env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is required");
  const migrationUrl = env.DATABASE_MIGRATION_URL?.trim() || url;
  return { url, migrationUrl, separate: loginOf(url) !== loginOf(migrationUrl) };
}

function loginOf(url: string): string {
  return decodeURIComponent(new URL(url).username);
}

export const SINGLE_DATABASE_URL_WARNING =
  "DATABASE_URL is used for both migrations and the app, so row-level security is not enforced. Set DATABASE_MIGRATION_URL to the owner role and DATABASE_URL to a runtime login (docs/self-host-configuration.md#database-roles).";

/**
 * Create or update the runtime login named in `runtimeUrl` and give it the
 * runtime grants. Runs as the migration (owner) role after migrations, so a
 * password change in DATABASE_URL takes effect on the next deploy. A login
 * that is a superuser or bypasses RLS is left alone and reported instead.
 */
export async function provisionRuntimeRole(
  migrationUrl: string,
  runtimeUrl: string,
): Promise<{ warning?: string }> {
  const owner = new Client({ connectionString: migrationUrl });
  await owner.connect();
  try {
    const provisioned = await provisionWith(owner, runtimeUrl);
    if (provisioned.warning) return provisioned;
    // A key from a password the login does not have would lock out the running release.
    const runtime = new Client({ connectionString: runtimeUrl });
    const connected = await runtime.connect().then(
      () => true,
      () => false,
    );
    await runtime.end().catch(() => undefined);
    if (!connected) return { warning: RUNTIME_LOGIN_FAILED_WARNING };
    if (!rlsBypassKey(runtimeUrl)) {
      // With no digest stored, the policies accept the keyless bypass this login sends.
      await owner.query("DELETE FROM rakazo_private.rls_bypass_keys");
      return { warning: NO_BYPASS_KEY_WARNING };
    }
    await storeBypassKey(owner, runtimeUrl);
    return {};
  } finally {
    await owner.end();
  }
}

async function provisionWith(owner: Client, runtimeUrl: string): Promise<{ warning?: string }> {
  const parsed = new URL(runtimeUrl);
  const login = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  if (!login) throw new Error("DATABASE_URL must name the runtime login");
  // The migration creates the role and grants too; repeating them here covers a
  // restore into a fresh cluster (roles are not in a database dump) and tables
  // another role created.
  const group = await owner.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [RUNTIME_ROLE]);
  if (!group.rowCount) {
    await owner
      .query(`CREATE ROLE ${RUNTIME_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`)
      .catch((error: unknown) => {
        throw new Error(
          `Could not create role ${RUNTIME_ROLE}; the migration role needs CREATEROLE, or create it NOLOGIN NOBYPASSRLS yourself`,
          { cause: error },
        );
      });
  }
  await owner.query(`
    GRANT USAGE ON SCHEMA public TO ${RUNTIME_ROLE};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RUNTIME_ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RUNTIME_ROLE};
    REVOKE ALL ON TABLE "_prisma_migrations" FROM ${RUNTIME_ROLE};
    REVOKE UPDATE ON TABLE "security_events" FROM ${RUNTIME_ROLE};
    REVOKE UPDATE ON TABLE "audit_events" FROM ${RUNTIME_ROLE};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${RUNTIME_ROLE};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${RUNTIME_ROLE};
  `);
  // The runtime group may be created after migrations, or restored without its grants.
  // Older databases need provisioning too, so each helper is optional until migrated.
  await owner.query(`DO $$ BEGIN
    IF to_regprocedure('public.app_vault_item_unrestricted(text)') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION public.app_vault_item_unrestricted(text) TO ${RUNTIME_ROLE};
    END IF;
    IF to_regprocedure('public.app_vault_run_unrestricted(text,text)') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION public.app_vault_run_unrestricted(text, text) TO ${RUNTIME_ROLE};
    END IF;
  END $$`);
  await owner.query(
    `DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${RUNTIME_ROLE}', current_database()); END $$`,
  );
  await grantJobQueue(owner);
  const existing = await owner.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1",
    [login],
  );
  const role = existing.rows[0];
  if (role && (role.rolsuper || role.rolbypassrls)) {
    return {
      warning: `DATABASE_URL logs in as ${login}, which ${role.rolsuper ? "is a superuser" : "bypasses row-level security"}; row-level security is not enforced.`,
    };
  }
  const [admin] = (
    await owner.query<{ can: boolean; superuser: boolean }>(
      "SELECT rolsuper OR rolcreaterole AS can, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user",
    )
  ).rows;
  // A login an administrator already created and granted rakazo_app (inheritably, so
  // it can use the grants without SET ROLE) is used as it is when this role may not
  // change it: no CREATEROLE (some managed Postgres), or, on PostgreSQL 16+,
  // CREATEROLE without ADMIN OPTION on that login.
  const provisioned =
    Boolean(role) &&
    (
      await owner.query<{ member: boolean }>("SELECT pg_has_role($1, $2, 'USAGE') AS member", [
        login,
        RUNTIME_ROLE,
      ])
    ).rows[0]?.member === true;
  const cannotChange = () =>
    new Error(
      `The migration role cannot create or change ${login}. Create it (LOGIN NOBYPASSRLS) and GRANT ${RUNTIME_ROLE} TO it, then deploy again.`,
    );
  if (!admin?.can) {
    if (provisioned) return {};
    throw cannotChange();
  }
  const name = escapeIdentifier(login);
  const secret = password ? `PASSWORD ${escapeLiteral(scramSha256Verifier(password))}` : "";
  // Only a superuser may set SUPERUSER, BYPASSRLS or REPLICATION, even to false. A
  // CREATEROLE owner leaves them at their defaults (off), and a login that already has
  // one of them was returned above.
  const limits = admin.superuser
    ? "NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION"
    : "";
  try {
    if (!role) await owner.query(`CREATE ROLE ${name} LOGIN ${secret} ${limits}`);
    else await owner.query(`ALTER ROLE ${name} LOGIN ${secret} ${limits}`);
    if (login !== RUNTIME_ROLE) await owner.query(`GRANT ${RUNTIME_ROLE} TO ${name}`);
  } catch (error) {
    const denied = (error as { code?: string }).code === "42501";
    if (denied && provisioned) return {};
    if (denied) throw Object.assign(cannotChange(), { cause: error });
    throw error;
  }
  return {};
}

const RUNTIME_LOGIN_FAILED_WARNING =
  "Could not log in with DATABASE_URL, so its row-level security bypass key was not registered.";

const NO_BYPASS_KEY_WARNING =
  "DATABASE_URL has no password, so SQL run for one tenant could turn on the cross-tenant bypass. Give the runtime login a password.";

/** Lets the runtime login's system context through the policies (see rlsBypassKey). */
async function storeBypassKey(owner: Client, runtimeUrl: string): Promise<void> {
  // One statement, so the table is never empty, which would accept the bypass alone.
  await owner.query(
    `WITH stored AS (
       INSERT INTO rakazo_private.rls_bypass_keys (digest) VALUES (sha256(convert_to($1, 'UTF8')))
       ON CONFLICT (digest) DO NOTHING
     )
     DELETE FROM rakazo_private.rls_bypass_keys WHERE digest <> sha256(convert_to($1, 'UTF8'))`,
    [rlsBypassKey(runtimeUrl)],
  );
}

/**
 * The SCRAM-SHA-256 verifier PostgreSQL would store for `password`. Sending it
 * instead of the password keeps the plaintext out of server logs and audit trails.
 */
export function scramSha256Verifier(password: string, salt = randomBytes(16), iterations = 4096) {
  // SASLprep's mappings (RFC 4013), as PostgreSQL and pg apply them.
  const prepared = password
    .replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000]/g, " ")
    .replace(
      /\u00AD|\u034F|\u1806|[\u180B-\u180D]|\u200C|\u200D|\u2060|[\uFE00-\uFE0F]|\uFEFF/g,
      "",
    )
    .normalize("NFKC");
  const salted = pbkdf2Sync(prepared, salt, iterations, 32, "sha256");
  const hmac = (text: string) => createHmac("sha256", salted).update(text).digest();
  const storedKey = createHash("sha256").update(hmac("Client Key")).digest("base64");
  const serverKey = hmac("Server Key").toString("base64");
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey}:${serverKey}`;
}

/** Policy on each graphile-worker table that lets the runtime role use the job queue. */
export const JOB_QUEUE_POLICY = "rakazo_app_queue";

/**
 * graphile-worker's schema is installed by the job queue migration that runs
 * just before this, so its grants cannot live in a Prisma migration.
 *
 * graphile-worker enables row-level security with no policies on its
 * `_private_*` tables. Their owner (the migration role) bypasses that; the
 * runtime role would see no jobs and could not add any. Those rows are queue
 * metadata whose payloads carry ids only, not tenant content, so the runtime
 * role gets every row. The policy is recreated on each run, for every table with
 * RLS on, so tables a graphile-worker upgrade adds or rebuilds are covered and a
 * hand-made policy of the same name is replaced by this definition.
 */
async function grantJobQueue(owner: Client): Promise<void> {
  await owner.query(`
    DO $$
    DECLARE
      queue_table regclass;
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'graphile_worker') THEN
        RETURN;
      END IF;
      GRANT USAGE ON SCHEMA graphile_worker TO ${RUNTIME_ROLE};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA graphile_worker TO ${RUNTIME_ROLE};
      GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA graphile_worker TO ${RUNTIME_ROLE};
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA graphile_worker TO ${RUNTIME_ROLE};
      -- Skip tables that already have exactly this policy, so a deploy does not
      -- take the lock DROP and CREATE POLICY need on a busy queue.
      FOR queue_table IN
        SELECT c.oid FROM pg_class c
        WHERE c.relnamespace = 'graphile_worker'::regnamespace
          AND c.relkind IN ('r', 'p') AND c.relrowsecurity
          AND NOT EXISTS (
            SELECT 1 FROM pg_policy p
            WHERE p.polrelid = c.oid AND p.polname = '${JOB_QUEUE_POLICY}'
              AND p.polcmd = '*' AND p.polpermissive
              AND p.polroles = ARRAY['${RUNTIME_ROLE}'::regrole::oid]
              AND pg_get_expr(p.polqual, p.polrelid) = 'true'
              AND pg_get_expr(p.polwithcheck, p.polrelid) = 'true'
          )
      LOOP
        EXECUTE format('DROP POLICY IF EXISTS ${JOB_QUEUE_POLICY} ON %s', queue_table);
        EXECUTE format(
          'CREATE POLICY ${JOB_QUEUE_POLICY} ON %s FOR ALL TO ${RUNTIME_ROLE} USING (true) WITH CHECK (true)',
          queue_table
        );
      END LOOP;
    END $$;
  `);
}

export interface RowSecurityStatus {
  enforced: boolean;
  role: string;
  reason?: string;
  /** The bypass key does not match the one `pnpm db:migrate` registered. */
  systemBlocked?: boolean;
}

/** Whether the connected login is actually subject to the row-level security policies. */
export async function describeRowSecurity(prisma: PrismaClient): Promise<RowSecurityStatus> {
  const [row] = await prisma.$queryRawUnsafe<
    Array<{
      role: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      owns: boolean;
    }>
  >(`SELECT current_user AS role, r.rolsuper, r.rolbypassrls,
        pg_has_role(current_user, c.relowner, 'USAGE') AS owns
      FROM pg_roles r, pg_class c
      WHERE r.rolname = current_user AND c.oid = 'public.messages'::regclass`);
  if (!row) return { enforced: false, role: "unknown", reason: "could not read the role" };
  const reason = row.rolsuper
    ? "is a superuser"
    : row.rolbypassrls
      ? "has BYPASSRLS"
      : row.owns
        ? "owns the tables"
        : undefined;
  if (reason) return { enforced: false, role: row.role, reason };
  const [system] = await runAsSystem(
    "check the row-level security bypass key",
    () => prisma.$queryRaw<Array<{ ok: boolean }>>`SELECT app_rls_bypass() AS ok`,
  );
  return { enforced: true, role: row.role, ...(system?.ok ? {} : { systemBlocked: true }) };
}

export function rowSecurityWarning(status: RowSecurityStatus): string | undefined {
  if (status.systemBlocked)
    return "Background work across Spaces is blocked: DATABASE_URL's password changed since `pnpm db:migrate` last ran. Run it again.";
  if (status.enforced) return undefined;
  return `Row-level security is not enforced: the app connects as ${status.role}, which ${status.reason}. Point DATABASE_URL at a runtime login and DATABASE_MIGRATION_URL at the owner (docs/self-host-configuration.md#database-roles).`;
}
