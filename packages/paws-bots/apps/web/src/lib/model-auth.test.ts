import { beforeEach, describe, expect, it, vi } from "vitest";
import { waitForModelOAuth } from "./model-auth";
import { rpc } from "./rpc";

vi.mock("./rpc", () => ({
  rpc: { models: { completeOAuth: vi.fn() } },
}));

describe("waitForModelOAuth", () => {
  const completeOAuth = vi.mocked(rpc.models.completeOAuth);

  beforeEach(() => {
    completeOAuth.mockReset();
  });

  it("stops polling when its signal is aborted", async () => {
    completeOAuth.mockResolvedValue({ status: "pending" });
    const controller = new AbortController();
    const polling = waitForModelOAuth("login-id", controller.signal);

    await Promise.resolve();
    expect(completeOAuth).toHaveBeenCalledTimes(1);
    controller.abort();

    await expect(polling).rejects.toBeDefined();
    expect(completeOAuth).toHaveBeenCalledTimes(1);
  });

  it("returns readiness without waiting for another poll", async () => {
    completeOAuth.mockResolvedValue({ status: "ready" });

    await expect(waitForModelOAuth("login-id")).resolves.toMatchObject({ status: "ready" });
    expect(completeOAuth).toHaveBeenCalledTimes(1);
  });

  it("polls through the client that began the sign-in", async () => {
    const bound = vi.fn().mockResolvedValue({ status: "ready" });
    const client = { models: { completeOAuth: bound } } as unknown as Parameters<
      typeof waitForModelOAuth
    >[2];
    await waitForModelOAuth("login-id", undefined, client);
    expect(bound).toHaveBeenCalledWith({ loginId: "login-id" }, { signal: undefined });
    expect(completeOAuth).not.toHaveBeenCalled();
  });
});
