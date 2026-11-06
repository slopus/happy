import * as path from "node:path";

/**
 * Resolve a request to the unauthenticated static files route.
 *
 * Only the `public/` namespace is served here. It is the one `uploadImage`
 * writes, and the only tree under the storage root meant to be readable
 * without a bearer token. Everything else — session attachments, session and
 * project avatars, and any namespace added later — is reachable solely through
 * the authenticated routes that check ownership.
 *
 * This is an allow-list on purpose. A deny-list has to enumerate every private
 * namespace, and silently exposes the next one added.
 */
export function publicLocalFilePath(baseDir: string, requestedPath: string): string | null {
  const root = path.resolve(baseDir);
  const fullPath = path.resolve(root, requestedPath);
  if (!fullPath.startsWith(root + path.sep)) return null;
  const parts = path.relative(root, fullPath).split(path.sep);
  if (parts[0] !== "public") return null;
  return fullPath;
}
