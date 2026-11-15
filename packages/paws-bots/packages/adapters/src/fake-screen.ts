import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A still desktop: the real computer's wallpaper with a browser window open. The root's
 * `noVNC_connected` class is what the screen proxy's shim reports as a connected screen.
 */
export const FAKE_SCREEN_HTML = `<!doctype html>
<html class="noVNC_connected" lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Computer</title>
<style>
html,body{margin:0;height:100%;overflow:hidden}
body{background:radial-gradient(120% 90% at 50% 0%,#2c2c31 0%,#18181b 55%,#111113 100%)}
.window{position:absolute;inset:7% 9% 12%;display:flex;flex-direction:column;overflow:hidden;border-radius:.8vw;background:#fafafa;box-shadow:0 2vw 5vw rgb(0 0 0/.55),0 0 0 1px rgb(255 255 255/.06)}
.bar{display:flex;align-items:center;gap:1.2vw;height:3.4vw;padding:0 1.2vw;background:#ececee;border-bottom:1px solid #dcdce0}
.dots{display:flex;gap:.6vw}
.dots i{width:.9vw;height:.9vw;border-radius:50%;background:#c4c4c9}
.address{flex:1;max-width:55%;height:1.9vw;margin:0 auto;border-radius:1vw;background:#fff;border:1px solid #dcdce0}
.page{flex:1;display:grid;align-content:start;gap:1.4vw;padding:5vw 8vw}
.page i{display:block;height:1.1vw;border-radius:.6vw;background:#e4e4e7}
.page .heading{width:40%;height:2.2vw;background:#d4d4d8}
.taskbar{position:absolute;inset:auto 0 0;height:4.5%;background:rgb(0 0 0/.4);border-top:1px solid rgb(255 255 255/.05)}
</style>
</head><body>
<div class="window" aria-hidden="true">
<div class="bar"><span class="dots"><i></i><i></i><i></i></span><span class="address"></span></div>
<div class="page"><i class="heading"></i><i></i><i style="width:92%"></i><i style="width:78%"></i><i style="width:85%"></i><i style="width:60%"></i></div>
</div>
<div class="taskbar" aria-hidden="true"></div>
</body></html>
`;

/**
 * Loopback page standing in for a computer's noVNC screen, so a fake computer's screen loads
 * through the same sealed capability and web proxy as a real one.
 */
export class FakeScreenServer {
  private server: http.Server | null = null;
  private listening: Promise<number> | null = null;

  async url(computerId: string, screen: string): Promise<string> {
    const port = await this.start();
    const query = new URLSearchParams({ computer: computerId, screen });
    return `http://127.0.0.1:${port}/embed.html?${query}`;
  }

  close() {
    this.server?.closeAllConnections();
    this.server?.close();
    this.server = null;
    this.listening = null;
  }

  private start() {
    this.listening ??= new Promise<number>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const pathname = req.url?.split("?")[0];
        if (pathname !== "/embed.html" || (req.method !== "GET" && req.method !== "HEAD")) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(req.method === "HEAD" ? undefined : FAKE_SCREEN_HTML);
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.unref();
        resolve((server.address() as AddressInfo).port);
      });
      this.server = server;
    });
    return this.listening;
  }
}
