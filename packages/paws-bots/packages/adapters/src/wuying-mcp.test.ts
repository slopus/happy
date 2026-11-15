import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpSession } from "./mcp-transport.js";
import { WuyingMcpTools } from "./wuying-sandbox.js";

const signal = new AbortController().signal;
const token = "fake-gateway-token";
const tools = () => new WuyingMcpTools({ url: "https://gateway.example.test/mcp", token });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Wuying gateway credential handling", () => {
  it("does not propagate transport errors that echo credentials", async () => {
    const connect = vi
      .spyOn(McpSession.prototype, "connectRemote")
      .mockRejectedValue(new Error(token));
    const unreachable = tools().call("env_get", {}, signal);
    await expect(unreachable).rejects.toThrow("The computer gateway could not be reached");
    await expect(unreachable).rejects.not.toHaveProperty("cause");
    connect.mockResolvedValue({ transport: "streamable-http", usedFallback: false });
    vi.spyOn(McpSession.prototype, "callTool").mockRejectedValue(new Error(token));
    vi.spyOn(McpSession.prototype, "close").mockResolvedValue(undefined);
    const unanswered = tools().call("env_get", {}, signal);
    await expect(unanswered).rejects.toThrow("The computer did not answer env_get");
    await expect(unanswered).rejects.not.toHaveProperty("cause");
  });

  it("keeps only the not_found code from a tool error, with no echoed body or token", async () => {
    vi.spyOn(McpSession.prototype, "connectRemote").mockResolvedValue({
      transport: "streamable-http",
      usedFallback: false,
    });
    const call = vi.spyOn(McpSession.prototype, "callTool").mockResolvedValue({
      isError: true,
      content: [{ type: "text", text: token }],
      structuredContent: { error: { code: "not_found", message: token } },
    });
    await expect(tools().call("fs_info", {}, signal)).rejects.toMatchObject({
      code: "not_found",
      message: "fs_info failed",
    });
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe("Wuying gateway reconnection", () => {
  const connected = { transport: "streamable-http", usedFallback: false } as const;
  const response = { content: [], structuredContent: { data: { ready: true } } };
  const closed = () => new McpError(ErrorCode.ConnectionClosed, "Connection closed");

  beforeEach(() => vi.useFakeTimers());

  function gateway() {
    const connect = vi.spyOn(McpSession.prototype, "connectRemote").mockResolvedValue(connected);
    const call = vi.spyOn(McpSession.prototype, "callTool").mockResolvedValue(response);
    const close = vi.spyOn(McpSession.prototype, "close").mockResolvedValue(undefined);
    return { connect, call, close, client: tools() };
  }

  it("keeps the shared connection when one call is refused", async () => {
    const { client, connect, call, close } = gateway();
    call.mockRejectedValueOnce(new McpError(ErrorCode.InvalidParams, "bad path"));
    await expect(client.call("fs_write", {}, signal)).rejects.toThrow(
      "The computer did not answer fs_write",
    );
    await client.call("env_get", {}, signal);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  it.each([
    closed(),
    new StreamableHTTPError(404, "Session expired"),
    new TypeError("fetch failed"),
  ])("reconnects a read after a lost session and reuses its replacement (%s)", async (error) => {
    const { client, connect, call, close } = gateway();
    call.mockRejectedValueOnce(error);
    const recovered = expect(client.call("fs_info", {}, signal)).resolves.toMatchObject({
      data: { ready: true },
    });
    await vi.advanceTimersByTimeAsync(500);
    await recovered;
    await client.call("env_get", {}, signal);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
    expect(call.mock.contexts[0]).not.toBe(call.mock.contexts[1]);
    expect(call.mock.contexts[1]).toBe(call.mock.contexts[2]);
  });

  it("retries a temporary handshake failure before sending a command once", async () => {
    const { client, connect, call } = gateway();
    connect.mockRejectedValueOnce(new StreamableHTTPError(502, token));
    const recovered = expect(client.call("process_exec", {}, signal)).resolves.toMatchObject({
      data: { ready: true },
    });
    await vi.advanceTimersByTimeAsync(500);
    await recovered;
    expect(connect).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it.each([
    "process_exec",
    "app_start",
    "app_stop",
    "fs_write",
    "fs_mkdir",
    "fs_delete",
    "input_mouse",
    "input_keyboard",
    "input_text",
    "window_update",
  ])("does not repeat %s after its response is lost", async (tool) => {
    const { client, connect, call, close } = gateway();
    call.mockRejectedValueOnce(closed());
    await expect(client.call(tool, {}, signal)).rejects.toThrow(
      `The computer did not answer ${tool}`,
    );
    expect(call).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    await client.call("env_get", {}, signal);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("stops after one reconnect and keeps gateway credentials out of the error", async () => {
    const { client, connect, call } = gateway();
    call.mockRejectedValue(new StreamableHTTPError(502, token));
    const request = client.call("fs_info", {}, signal);
    const failed = expect(request).rejects.toMatchObject({
      name: "SandboxUnresponsiveError",
      message: "The computer did not answer fs_info",
    });
    await vi.advanceTimersByTimeAsync(500);
    await failed;
    await expect(request).rejects.not.toHaveProperty("cause");
    expect(connect).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it.each([
    new StreamableHTTPError(401, token),
    new StreamableHTTPError(403, token),
    new McpError(ErrorCode.InvalidParams, token),
  ])("does not retry an authorization or protocol rejection (%s)", async (error) => {
    const { client, connect, call } = gateway();
    call.mockRejectedValueOnce(error);
    await expect(client.call("fs_info", {}, signal)).rejects.toThrow(
      "The computer did not answer fs_info",
    );
    expect(connect).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("discards a failed session even when that request was cancelled", async () => {
    const { client, connect, call, close } = gateway();
    const controller = new AbortController();
    const reason = new Error("Request cancelled");
    call.mockImplementationOnce(async () => {
      controller.abort(reason);
      throw closed();
    });
    await expect(client.call("fs_info", {}, controller.signal)).rejects.toBe(reason);
    expect(close).toHaveBeenCalledTimes(1);
    await client.call("fs_info", {}, signal);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("cancels the reconnect delay without opening another connection", async () => {
    const { client, connect, call } = gateway();
    const controller = new AbortController();
    call.mockRejectedValueOnce(closed());
    const failed = expect(client.call("fs_info", {}, controller.signal)).rejects.toHaveProperty(
      "name",
      "AbortError",
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await failed;
    expect(connect).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("keeps the replacement when another call on the old session fails later", async () => {
    const { client, connect, call } = gateway();
    let rejectOld!: (error: Error) => void;
    const oldResponse = new Promise<never>((_, reject) => {
      rejectOld = reject;
    });
    call.mockImplementationOnce(() => oldResponse).mockRejectedValueOnce(closed());
    const oldRead = expect(client.call("env_get", {}, signal)).resolves.toMatchObject({
      data: { ready: true },
    });
    const recovered = expect(client.call("fs_info", {}, signal)).resolves.toMatchObject({
      data: { ready: true },
    });
    await vi.advanceTimersByTimeAsync(500);
    await recovered;
    rejectOld(closed());
    await vi.advanceTimersByTimeAsync(500);
    await oldRead;
    expect(connect).toHaveBeenCalledTimes(2);
    expect(call.mock.contexts[2]).toBe(call.mock.contexts[3]);
  });
});
