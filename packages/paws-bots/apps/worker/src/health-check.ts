import { readFileSync } from "node:fs";
import { WORKER_HEALTH_FILE, workerHealthIsFresh } from "./health.js";

try {
  process.exitCode = workerHealthIsFresh(JSON.parse(readFileSync(WORKER_HEALTH_FILE, "utf8")))
    ? 0
    : 1;
} catch {
  process.exitCode = 1;
}
