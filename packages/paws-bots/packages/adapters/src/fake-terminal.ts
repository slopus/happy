import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { TERMINAL_INPUT, TERMINAL_RESIZE } from "@rakazo/contracts";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

type Session = { owner: string; lease: string; cwd: string };

/**
 * Loopback stand-in for the computer's terminal gateway. It speaks the same websocket and
 * frame protocol as websockify plus the PTY server, but answers with an emulated shell so
 * fake computers never expose a real host shell. Tests use it to drive the browser terminal
 * through the sealed capability and the web proxy end to end.
 */
export class FakeTerminalGateway {
  private server: http.Server | null = null;
  private listening: Promise<number> | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly connections = new Map<Duplex, Session>();

  /** Open a session for `owner` (a computer) under a control lease; `revoke` ends it. */
  async open(owner: string, lease: string, cwd: string): Promise<string> {
    const port = await this.start();
    const token = randomUUID();
    this.sessions.set(token, { owner, lease, cwd });
    const socketPath = `websockify?token=${token}`;
    return `http://127.0.0.1:${port}/vnc.html?path=${encodeURIComponent(socketPath)}`;
  }

  /**
   * Refuse the owner's tokens and disconnect its shells, like stopping the real server. With a
   * lease, only that lease's sessions end, as a real release checks the control token.
   */
  revoke(owner: string, lease?: string) {
    const matches = (session: Session) =>
      session.owner === owner && (lease === undefined || session.lease === lease);
    for (const [token, session] of this.sessions) {
      if (matches(session)) this.sessions.delete(token);
    }
    for (const [socket, session] of this.connections) {
      if (matches(session)) socket.destroy();
    }
  }

  close() {
    // Upgraded sockets are no longer tracked by the HTTP server, so end them here.
    for (const socket of this.connections.keys()) socket.destroy();
    this.server?.close();
    this.server = null;
    this.listening = null;
    this.sessions.clear();
  }

  private start() {
    this.listening ??= new Promise<number>((resolve, reject) => {
      const server = http.createServer((_req, res) => {
        res.writeHead(404).end();
      });
      server.on("upgrade", (req, socket) => this.upgrade(req, socket));
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.unref();
        resolve((server.address() as AddressInfo).port);
      });
      this.server = server;
    });
    return this.listening;
  }

  private upgrade(req: http.IncomingMessage, socket: Duplex) {
    const url = new URL(req.url ?? "/", "http://fake-terminal.invalid");
    const session = this.sessions.get(url.searchParams.get("token") ?? "");
    const key = req.headers["sec-websocket-key"];
    if (url.pathname !== "/websockify" || !session || typeof key !== "string") {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const accept = createHash("sha1")
      .update(key + WEBSOCKET_GUID)
      .digest("base64");
    const protocols = String(req.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((value) => value.trim());
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        ...(protocols.includes("binary") ? ["Sec-WebSocket-Protocol: binary"] : []),
        "",
        "",
      ].join("\r\n"),
    );
    this.connections.set(socket, session);
    socket.on("close", () => this.connections.delete(socket));
    const shell = new FakeShell(
      session.cwd,
      (text) => socket.write(encodeFrame(0x2, text)),
      () => socket.end(encodeFrame(0x8, Buffer.alloc(0))),
    );
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const frame = decodeFrame(pending);
        if (!frame) break;
        pending = pending.subarray(frame.length);
        if (frame.opcode === 0x8) {
          socket.end(encodeFrame(0x8, Buffer.alloc(0)));
          return;
        }
        if (frame.opcode === 0x9) socket.write(encodeFrame(0xa, frame.payload));
        else if (frame.opcode <= 0x2) shell.receive(frame.payload);
      }
    });
    socket.on("error", () => socket.destroy());
    shell.start();
  }
}

/** A line-editing shell that understands `echo`, `pwd`, `stty size`, and `exit`. */
class FakeShell {
  private rows = 24;
  private cols = 80;
  private line = "";
  private frames = Buffer.alloc(0);

  constructor(
    private readonly cwd: string,
    private readonly write: (text: Buffer) => void,
    private readonly exit: () => void,
  ) {}

  start() {
    this.print("$ ");
  }

  receive(bytes: Buffer) {
    this.frames = Buffer.concat([this.frames, bytes]);
    while (this.frames.length >= 5) {
      const size = this.frames.readUInt32BE(1);
      if (this.frames.length < 5 + size) return;
      const kind = this.frames[0];
      const payload = this.frames.subarray(5, 5 + size);
      this.frames = this.frames.subarray(5 + size);
      if (kind === TERMINAL_RESIZE && payload.length === 4) {
        this.cols = payload.readUInt16BE(0);
        this.rows = payload.readUInt16BE(2);
      } else if (kind === TERMINAL_INPUT) {
        for (const char of payload.toString("utf8")) this.type(char);
      }
    }
  }

  private type(char: string) {
    if (char === "\r" || char === "\n") {
      this.print("\r\n");
      if (this.line.trim() === "exit") {
        this.exit();
        return;
      }
      const output = this.run(this.line.trim());
      if (output) this.print(`${output}\r\n`);
      this.line = "";
      this.print("$ ");
    } else if (char === "\x7f") {
      if (!this.line) return;
      this.line = this.line.slice(0, -1);
      this.print("\b \b");
    } else if (char >= " ") {
      this.line += char;
      this.print(char);
    }
  }

  private run(command: string) {
    if (!command) return "";
    if (command === "pwd") return this.cwd;
    if (command === "stty size") return `${this.rows} ${this.cols}`;
    if (command === "echo" || command.startsWith("echo ")) return command.slice(5);
    return `fake-shell: ${command.split(/\s+/)[0]}: command not found`;
  }

  private print(text: string) {
    this.write(Buffer.from(text, "utf8"));
  }
}

function encodeFrame(opcode: number, payload: Buffer) {
  const header =
    payload.length < 126
      ? Buffer.from([0x80 | opcode, payload.length])
      : payload.length < 65536
        ? Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 0xff])
        : (() => {
            const long = Buffer.alloc(10);
            long[0] = 0x80 | opcode;
            long[1] = 127;
            long.writeBigUInt64BE(BigInt(payload.length), 2);
            return long;
          })();
  return Buffer.concat([header, payload]);
}

/** Parse one client frame; clients always mask their payloads. */
function decodeFrame(buffer: Buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0]! & 0x0f;
  const masked = (buffer[1]! & 0x80) !== 0;
  let size = buffer[1]! & 0x7f;
  let offset = 2;
  if (size === 126) {
    if (buffer.length < 4) return null;
    size = buffer.readUInt16BE(2);
    offset = 4;
  } else if (size === 127) {
    if (buffer.length < 10) return null;
    size = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskOffset = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + size) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + size));
  if (masked) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index]! ^= buffer[maskOffset + (index % 4)]!;
    }
  }
  return { opcode, payload, length: offset + size };
}
