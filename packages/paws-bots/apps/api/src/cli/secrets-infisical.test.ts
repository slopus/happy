import { expect, it, vi } from "vitest";

const loadRootEnv = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("env-loader-sentinel");
  }),
);
vi.mock("@rakazo/core/node/load-root-env", () => ({ loadRootEnv }));

it("loads the root environment before reading migration configuration", async () => {
  await expect(import("./secrets-infisical.js")).rejects.toThrow("env-loader-sentinel");
  expect(loadRootEnv).toHaveBeenCalledOnce();
});
