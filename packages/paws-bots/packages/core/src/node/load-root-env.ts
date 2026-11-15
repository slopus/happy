import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "dotenv";

export function loadRootEnv(options: { allowInTests?: boolean } = {}) {
  // Test runners and verification CLIs supply their own isolated environment.
  // Loading a developer's credentials here also changes otherwise offline tests.
  if (process.env.NODE_ENV === "test" && !options.allowInTests) return;
  // A host that passes the whole environment itself (the desktop app) must not pick up a stray
  // `.env` from a parent directory such as the person's home.
  if (process.env.RAKAZO_ENV_FILE === "none") return;
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, ".env");
    if (existsSync(candidate)) {
      config({ path: candidate, override: false });
      if (process.env.DATA_DIR && !path.isAbsolute(process.env.DATA_DIR)) {
        process.env.DATA_DIR = path.resolve(dir, process.env.DATA_DIR);
      }
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  config();
}
