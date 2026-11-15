import { encodeTerminalInput, encodeTerminalResize } from "@rakazo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { FakeTerminalGateway } from "./fake-terminal.js";

const gateways: FakeTerminalGateway[] = [];
afterEach(() => {
  for (const gateway of gateways.splice(0)) gateway.close();
});

async function connect(
  cwd = "/home/rakazo/bots/bot-1",
  gateway = new FakeTerminalGateway(),
  lease = "lease-1",
) {
  if (!gateways.includes(gateway)) gateways.push(gateway);
  const page = new URL(await gateway.open("computer-1", lease, cwd));
  const target = new URL(page.searchParams.get("path")!, page);
  target.protocol = "ws:";
  const socket = new WebSocket(target, ["binary"]);
  socket.binaryType = "arraybuffer";
  let output = "";
  socket.addEventListener("message", (event) => {
    output += new TextDecoder().decode(event.data as ArrayBuffer);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const waitFor = async (pattern: RegExp) => {
    for (let i = 0; i < 250; i += 1) {
      if (pattern.test(output)) return output;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`fake terminal output did not match ${pattern}: ${JSON.stringify(output)}`);
  };
  const closed = new Promise((resolve) =>
    socket.addEventListener("close", resolve, { once: true }),
  );
  return { socket, waitFor, closed, page };
}

function refused(url: string) {
  const socket = new WebSocket(url);
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("refused")), { once: true });
  });
}

describe("fake terminal gateway", () => {
  it("speaks the terminal frame protocol over a websocket", async () => {
    const { socket, waitFor } = await connect();
    await waitFor(/^\$ $/);
    socket.send(encodeTerminalResize(132, 40));
    // Split input across frames the way keystrokes arrive from xterm.
    for (const key of ["echo hel", "lo\r", "stty size\r", "pwd\r", "ls\r"]) {
      socket.send(encodeTerminalInput(key));
    }
    const output = await waitFor(/command not found\r\n\$ $/);
    expect(output).toContain("$ echo hello\r\nhello\r\n");
    expect(output).toContain("$ stty size\r\n40 132\r\n");
    expect(output).toContain("$ pwd\r\n/home/rakazo/bots/bot-1\r\n");
    expect(output).toContain("fake-shell: ls: command not found");
  });

  it("rejects unknown tokens", async () => {
    const { page } = await connect();
    await expect(refused(`ws://${page.host}/websockify?token=guess`)).rejects.toThrow("refused");
  });

  it("closes the connection when the shell exits", async () => {
    const { socket, waitFor, closed } = await connect();
    await waitFor(/^\$ $/);
    socket.send(encodeTerminalInput("exit\r"));
    await expect(closed).resolves.toBeDefined();
  });

  it("ends a computer's shells and refuses its tokens once revoked", async () => {
    const gateway = new FakeTerminalGateway();
    const { page, closed } = await connect(undefined, gateway);
    gateway.revoke("computer-1");
    await expect(closed).resolves.toBeDefined();
    const target = new URL(page.searchParams.get("path")!, page);
    target.protocol = "ws:";
    await expect(refused(target.toString())).rejects.toThrow("refused");
  });

  it("ends only the released lease's shells", async () => {
    const gateway = new FakeTerminalGateway();
    const old = await connect(undefined, gateway, "lease-old");
    const current = await connect(undefined, gateway, "lease-new");
    // A delayed release of the earlier lease must not end the current shell.
    gateway.revoke("computer-1", "lease-old");
    await expect(old.closed).resolves.toBeDefined();
    await current.waitFor(/^\$ $/);
    current.socket.send(encodeTerminalInput("echo still-here\r"));
    await expect(current.waitFor(/still-here\r\n\$ $/)).resolves.toContain("still-here");
  });

  it("ends open connections when the gateway closes", async () => {
    const gateway = new FakeTerminalGateway();
    const { closed } = await connect(undefined, gateway);
    gateway.close();
    await expect(closed).resolves.toBeDefined();
  });
});
