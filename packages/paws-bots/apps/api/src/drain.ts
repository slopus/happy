import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

const isStream = (request: IncomingMessage) =>
  request.headers.accept?.includes("text/event-stream") === true;

/**
 * Lets a replaced API finish its ordinary requests while streams and upgraded sockets close at
 * once, so clients reconnect to the new release instead of seeing a cut-off response.
 */
export function trackConnections(server: Server) {
  const sockets = new Set<Duplex>();
  const streams = new Set<Duplex>();
  const pending = new Set<ServerResponse>();
  let draining = false;
  const forget = (socket: Duplex) => {
    sockets.delete(socket);
    streams.delete(socket);
  };
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => forget(socket));
  });
  server.on("upgrade", (_request, socket: Duplex) => {
    streams.add(socket);
    if (draining) socket.destroy();
  });
  server.on("request", (request: IncomingMessage, response: ServerResponse) => {
    if (isStream(request)) {
      streams.add(request.socket);
      if (draining) request.socket.destroy();
      return;
    }
    if (draining) response.shouldKeepAlive = false;
    pending.add(response);
    response.once("close", () => pending.delete(response));
  });

  return async (graceMs: number) => {
    draining = true;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const socket of streams) socket.destroy();
    for (const response of pending) if (!response.headersSent) response.shouldKeepAlive = false;
    const grace = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
    }, graceMs);
    await closed;
    clearTimeout(grace);
  };
}
