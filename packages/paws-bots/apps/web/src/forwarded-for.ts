/**
 * The X-Forwarded-For the web proxy sends the API: whatever chain arrived, plus the hop this
 * proxy actually saw. The API reads past that hop only when it is in TRUSTED_PROXIES, so a
 * caller's own header can never become its address.
 */
export function appendForwardedFor(req: {
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress?: string };
}): string {
  const prior = [req.headers["x-forwarded-for"]].flat().filter(Boolean).join(", ");
  const peer = req.socket.remoteAddress ?? "unknown";
  return prior ? `${prior}, ${peer}` : peer;
}
