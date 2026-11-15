import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Compose resolves its default env file relative to the compose file, not the repo root
 * (see the comment in scripts/backup.sh), so a stack started with `pnpm compose:up` and its
 * root `.env` is unreachable unless Compose is pointed at that file.
 */
export function composeBaseArgs(root: string): string[] {
  const rootEnvFile = path.join(root, ".env");
  const args = ["compose"];
  if (existsSync(rootEnvFile)) args.push("--env-file", rootEnvFile);
  args.push("-f", path.join(root, "infra/compose/docker-compose.yml"));
  return args;
}

/** True when the stack's postgres answers; false for any failure, including no daemon. */
export function postgresUp(root: string): boolean {
  try {
    execFileSync(
      "docker",
      [...composeBaseArgs(root), "exec", "-T", "postgres", "pg_isready", "-U", "rakazo"],
      { stdio: "ignore", timeout: 8_000 },
    );
    return true;
  } catch {
    return false;
  }
}
