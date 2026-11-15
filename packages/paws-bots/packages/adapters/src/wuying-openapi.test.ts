import * as Appstream from "@alicloud/appstream-center20210218";
import * as Ecd from "@alicloud/ecd20200930";
import { SandboxRateLimitError, SandboxUnresponsiveError } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WuyingOpenApi } from "./wuying-openapi.js";

const EcdClient = (Ecd.default.default ?? Ecd.default) as typeof Ecd.default.default;
const AppstreamClient = (Appstream.default.default ??
  Appstream.default) as typeof Appstream.default.default;

const api = () =>
  new WuyingOpenApi({
    accessKeyId: "fake-key-id",
    accessKeySecret: "fake-secret",
    regionId: "cn-hangzhou",
  });
const signal = () => new AbortController().signal;
afterEach(() => vi.restoreAllMocks());

describe("Wuying official SDK control plane", () => {
  it("retries a failed client construction and caches the successful load", async () => {
    const construct = vi.spyOn(EcdClient.prototype, "checkConfig").mockImplementationOnce(() => {
      throw new Error("SDK setup failed");
    });
    const call = vi.spyOn(EcdClient.prototype, "callApi").mockResolvedValue({
      body: { Desktops: [{ DesktopId: "ecd-fake", DesktopStatus: "Running" }] },
    });
    const client = api();
    await expect(client.desktopStatus("ecd-fake", signal())).rejects.toEqual(
      new SandboxUnresponsiveError("Wuying DescribeDesktops failed"),
    );
    expect(call).not.toHaveBeenCalled();
    expect(await client.desktopStatus("ecd-fake", signal())).toBe("Running");
    expect(await client.desktopStatus("ecd-fake", signal())).toBe("Running");
    expect(construct).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("uses official request serialization and reads SDK response models for all four calls", async () => {
    const desktop = vi.spyOn(EcdClient.prototype, "callApi").mockResolvedValue({
      body: { Desktops: [{ DesktopId: "ecd-fake", DesktopStatus: "Running" }] },
    });
    const login = vi.spyOn(AppstreamClient.prototype, "callApi").mockResolvedValue({
      body: { AuthModel: { AuthCode: "fake-once" } },
    });
    const client = api();
    expect(await client.desktopStatus("ecd-fake", signal())).toBe("Running");
    expect(desktop.mock.calls[0]?.[0]).toMatchObject({ action: "DescribeDesktops" });
    expect(desktop.mock.calls[0]?.[1].query).toMatchObject({
      "DesktopId.1": "ecd-fake",
      RegionId: "cn-hangzhou",
    });
    desktop.mockResolvedValue({ body: {} });
    await client.startDesktop("ecd-fake", signal());
    await client.stopDesktop("ecd-fake", signal());
    expect(desktop.mock.calls.slice(1).map(([params]) => params.action)).toEqual([
      "StartDesktops",
      "StopDesktops",
    ]);
    expect(await client.authCode("fake-user", signal())).toBe("fake-once");
    expect(login.mock.calls[0]?.[0]).toMatchObject({ action: "GetAuthCode" });
    expect(login.mock.calls[0]?.[1].body).toMatchObject({ EndUserId: "fake-user" });
    expect(desktop.mock.calls[0]?.[2]).toMatchObject({
      connectTimeout: 15000,
      readTimeout: 15000,
      autoretry: false,
    });
    expect(await client.desktopStatus("missing", signal())).toBeNull();
  });

  it("never propagates SDK errors or response bodies containing credentials", async () => {
    const call = vi.spyOn(EcdClient.prototype, "callApi").mockRejectedValue({
      code: "fake-secret",
      message: "fake-key-id",
      data: { AuthCode: "fake-once" },
    });
    await expect(api().startDesktop("ecd-fake", signal())).rejects.toEqual(
      new SandboxUnresponsiveError("Wuying StartDesktops failed"),
    );
    call.mockRejectedValue({ code: "Throttling.User", data: "fake-secret" });
    await expect(api().startDesktop("ecd-fake", signal())).rejects.toBeInstanceOf(
      SandboxRateLimitError,
    );
    call.mockRejectedValue({ code: "InvalidAccessKeyId.NotFound", data: "fake-secret" });
    await expect(api().desktopStatus("ecd-fake", signal())).rejects.toThrow(
      /^Wuying DescribeDesktops: the AccessKey was refused$/,
    );
    call.mockRejectedValue({ code: "Forbidden.RAM", statusCode: 403 });
    await expect(api().startDesktop("ecd-fake", signal())).rejects.toThrow(
      "Wuying StartDesktops: the AccessKey is not allowed this action",
    );
    call.mockRejectedValue({ code: "InvalidDesktop.NotFound" });
    await expect(api().desktopStatus("ecd-fake", signal())).rejects.toMatchObject({
      name: "SandboxNotFoundError",
    });
    const login = vi.spyOn(AppstreamClient.prototype, "callApi").mockResolvedValue({ body: {} });
    await expect(api().authCode("fake-user", signal())).rejects.toThrow("no screen login code");
    expect(login).toHaveBeenCalledOnce();
  });

  it("honours cancellation before dispatch and while awaiting the bounded SDK call", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const call = vi
      .spyOn(EcdClient.prototype, "callApi")
      .mockImplementation(() => new Promise(() => {}));
    await expect(api().startDesktop("ecd-fake", controller.signal)).rejects.toThrow("cancelled");
    expect(call).not.toHaveBeenCalled();
    const pending = new AbortController();
    const request = api().startDesktop("ecd-fake", pending.signal);
    await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
    pending.abort(new Error("cancelled"));
    await expect(request).rejects.toThrow("cancelled");
  });
});
