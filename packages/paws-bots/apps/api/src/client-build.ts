import { readFileSync } from "node:fs";
import type { MinimumClientBuilds } from "@rakazo/contracts";
import {
  CLIENT_BUILD_HEADER,
  CLIENT_UPDATE_REQUIRED,
  CLIENT_UPDATE_REQUIRED_STATUS,
  clientUpdateRequired,
  isBuildId,
  SERVER_BUILD_HEADER,
} from "@rakazo/contracts";
import type { MiddlewareHandler } from "hono";

/**
 * The web build ships in the same image as the API, so reading its id from its assets keeps one
 * source of truth. Dev servers and images without a web build have none; the handshake stays quiet.
 */
export function readDeployedWebBuild(
  file: URL = new URL("../../web/dist/build-id", import.meta.url),
): string | undefined {
  try {
    const build = readFileSync(file, "utf8").trim();
    return isBuildId(build) ? build : undefined;
  } catch {
    return undefined;
  }
}

/** Names the deployed web build on every reply and refuses clients older than their minimum. */
export function clientBuildMiddleware(options: {
  webBuild: string | undefined;
  minimums: MinimumClientBuilds;
}): MiddlewareHandler {
  return async (c, next) => {
    if (clientUpdateRequired(c.req.header(CLIENT_BUILD_HEADER), options.minimums)) {
      // The oRPC error shape, so web and mobile clients read it like any other RPC failure.
      return c.json(
        {
          json: {
            defined: false,
            code: CLIENT_UPDATE_REQUIRED,
            status: CLIENT_UPDATE_REQUIRED_STATUS,
            message: "Update required",
          },
        },
        CLIENT_UPDATE_REQUIRED_STATUS,
        {
          "cache-control": "no-store",
          ...(options.webBuild ? { [SERVER_BUILD_HEADER]: options.webBuild } : {}),
        },
      );
    }
    await next();
    if (options.webBuild) c.header(SERVER_BUILD_HEADER, options.webBuild);
  };
}
