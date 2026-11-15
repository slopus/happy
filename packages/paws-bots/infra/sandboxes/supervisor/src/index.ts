import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { SERVICE_NAMES } from "@rakazo/logging";
import { createRootLogger } from "@rakazo/logging/axiom";
import { computerResourceLimits } from "./computer-spec.js";
import { computerEgressSetting, ensureComputerImage, screenNetworkMode } from "./context.js";
import { computerEgressMode, ensureRestrictedEgressEnforced } from "./egress.js";
import { reclaimIdleComputerNetworks } from "./networks.js";
import { supervisorApp } from "./routes.js";

export { supervisorApp };

async function startSupervisor() {
  const logger = await createRootLogger(SERVICE_NAMES.supervisor);
  // Resolve the ceilings before binding the port. They are otherwise parsed inside
  // containerCreateOptions, so a malformed RAKAZO_COMPUTER_* value would let the supervisor start
  // and pass its healthcheck, then fail the first POST /computers with a 500 that reads like a
  // Docker problem. Failing here names the variable while the deployment is still coming up.
  computerResourceLimits();
  if (computerEgressSetting === "auto" && screenNetworkMode !== "internal") {
    // Settle the mode before the first provision rather than on it.
    void ensureComputerImage()
      .then(ensureRestrictedEgressEnforced)
      .catch((error) => logger.error("computer egress probe failed", error));
  } else if (computerEgressMode === "restricted" && screenNetworkMode !== "internal") {
    // Report a missing host ruleset at startup too, not only on the first provision.
    void ensureComputerImage()
      .then(ensureRestrictedEgressEnforced)
      .then(() => logger.info("restricted computer egress verified"))
      .catch((error) => logger.error("restricted computer egress unavailable", error));
  }
  void reclaimIdleComputerNetworks().catch((error) => {
    logger.error("computer network reclaim failed", error);
  });
  const port = Number(process.env.SUPERVISOR_PORT ?? 7091);
  const hostname = process.env.SUPERVISOR_HOST ?? "127.0.0.1";
  const server = serve({ fetch: supervisorApp.fetch, hostname, port }, () => {
    logger.info("supervisor listening", { "http.host": hostname, "http.port": port });
  });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await closeListeningServer(server);
    await logger.flush({ timeoutMs: 2_000 });
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  return server;
}

function closeListeningServer(server: {
  close(callback?: (err?: Error) => void): void;
  closeIdleConnections?: () => void;
}): Promise<void> {
  server.closeIdleConnections?.();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  // A rejected startup keeps Node's default: the error is printed and the process exits.
  void startSupervisor();
}
