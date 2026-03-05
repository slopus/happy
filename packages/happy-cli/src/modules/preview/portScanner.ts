import * as net from "net";
import * as http from "http";

const COMMON_PORTS = [3000, 3001, 4173, 5173, 5174, 8000, 8080, 8082, 8090, 8888];
const DEFAULT_TIMEOUT_MS = 500;

/**
 * Check if a TCP port is open on localhost.
 */
export function checkPort(port: number, timeout = DEFAULT_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();

    const cleanup = () => {
      socket.destroy();
    };

    socket.setTimeout(timeout);

    socket.on("connect", () => {
      cleanup();
      resolve(true);
    });

    socket.on("timeout", () => {
      cleanup();
      resolve(false);
    });

    socket.on("error", () => {
      cleanup();
      resolve(false);
    });

    socket.connect(port, "127.0.0.1");
  });
}

/**
 * Perform an HTTP GET to localhost:{port}/ and extract the <title> text.
 * Returns undefined if the request fails or no title is found.
 */
export function fetchTitle(port: number, timeout = 2000): Promise<string | undefined> {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: "127.0.0.1", port, path: "/", timeout },
      (res) => {
        let body = "";

        res.setEncoding("utf8");

        res.on("data", (chunk: string) => {
          body += chunk;
          // Stop accumulating once we have enough to find <title>
          if (body.length > 8192) {
            req.destroy();
          }
        });

        res.on("end", () => {
          const match = body.match(/<title[^>]*>([^<]*)<\/title>/i);
          resolve(match ? match[1].trim() : undefined);
        });

        res.on("error", () => {
          resolve(undefined);
        });
      },
    );

    req.on("timeout", () => {
      req.destroy();
      resolve(undefined);
    });

    req.on("error", () => {
      resolve(undefined);
    });
  });
}

/**
 * Scan all common dev server ports in parallel.
 * Returns an array of alive ports with their optional page titles.
 */
export async function scanCommonPorts(): Promise<Array<{ port: number; title?: string }>> {
  const results = await Promise.all(
    COMMON_PORTS.map(async (port) => {
      const alive = await checkPort(port);
      if (!alive) return null;

      const title = await fetchTitle(port);
      return { port, title };
    }),
  );

  return results.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}
