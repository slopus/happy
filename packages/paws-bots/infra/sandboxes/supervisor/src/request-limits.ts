import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { maxUploadSizeBytes } from "./context.js";

export const MAX_SUPERVISOR_REQUEST_BYTES = 1024 * 1024;
function supervisorFileContentLimit(maxBytes: number): number {
  // Preserve the internal workspace-write allowance as well as configured chat uploads.
  return Math.max(16 * 1024 * 1024, Math.ceil(maxBytes / 3) * 4);
}

export const MAX_SUPERVISOR_FILE_REQUEST_BYTES =
  supervisorFileContentLimit(maxUploadSizeBytes) + 64 * 1024;

/** Keep normal control requests small; file writes also need a base64 JSON envelope. */
export function supervisorRequestBodyLimit(
  method: string,
  pathname: string,
  maxBytes = maxUploadSizeBytes,
): number {
  return method === "POST" && /^\/computers\/[^/]+\/files\/?$/.test(pathname)
    ? supervisorFileContentLimit(maxBytes) + 64 * 1024
    : MAX_SUPERVISOR_REQUEST_BYTES;
}

export function supervisorFileWriteSchema(maxBytes = maxUploadSizeBytes) {
  return z.object({
    path: z.string(),
    content: z.string().max(supervisorFileContentLimit(maxBytes)),
    executable: z.boolean().optional(),
  });
}

export const limitSupervisorRequestBody: MiddlewareHandler = async (c, next) => {
  return bodyLimit({
    maxSize: supervisorRequestBodyLimit(c.req.method, c.req.path),
    onError: (context) => context.json({ error: "Request body is too large." }, 413),
  })(c, next);
};
