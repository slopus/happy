import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("RAILWAY_API_TOKEN", "test-token");
  vi.stubEnv("RAILWAY_PROJECT_ID", "project");
  vi.stubEnv("RAILWAY_SERVICE_ID", "app");
  vi.stubEnv("RAILWAY_ENVIRONMENT_ID", "production");
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("reuses the sandbox environment without cloning application services", async () => {
  const fetch = vi.fn().mockResolvedValue(
    Response.json({
      data: {
        project: {
          environments: {
            edges: [
              {
                node: {
                  id: "isolated",
                  name: `sbx-${createHash("sha256").update("app:production").digest("hex").slice(0, 24)}`,
                },
              },
            ],
          },
        },
      },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  await import("../../../infra/railway/sandbox-environment.mjs");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(process.stdout.write).toHaveBeenCalledWith("isolated");
});

it("creates an empty environment with a bounded name when absent", async () => {
  vi.stubEnv("RAILWAY_SERVICE_ID", "00000000-0000-4000-8000-000000000000");
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ data: { project: { environments: { edges: [] } } } }))
    .mockResolvedValueOnce(Response.json({ data: { environmentCreate: { id: "isolated" } } }));
  vi.stubGlobal("fetch", fetch);
  await import("../../../infra/railway/sandbox-environment.mjs");
  expect(JSON.parse(fetch.mock.calls[1]?.[1].body).variables).toEqual({
    input: {
      name: `sbx-${createHash("sha256").update("00000000-0000-4000-8000-000000000000:production").digest("hex").slice(0, 24)}`,
      projectId: "project",
    },
  });
  expect(process.stdout.write).toHaveBeenCalledWith("isolated");
});

it("fails closed on API errors without disclosing the response", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ errors: [{ message: "private details" }] })),
  );
  await expect(import("../../../infra/railway/sandbox-environment.mjs")).rejects.toThrow(
    "Railway environment setup failed",
  );
  expect(process.stdout.write).not.toHaveBeenCalled();
});

it("refuses the application's environment", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        data: {
          project: {
            environments: {
              edges: [
                {
                  node: {
                    id: "production",
                    name: `sbx-${createHash("sha256").update("app:production").digest("hex").slice(0, 24)}`,
                  },
                },
              ],
            },
          },
        },
      }),
    ),
  );
  await expect(import("../../../infra/railway/sandbox-environment.mjs")).rejects.toThrow(
    "must be separate",
  );
  expect(process.stdout.write).not.toHaveBeenCalled();
});

it("keeps deployments of the same service in separate sandbox environments", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ data: { project: { environments: { edges: [] } } } }))
    .mockResolvedValueOnce(
      Response.json({ data: { environmentCreate: { id: "isolated-production" } } }),
    )
    .mockResolvedValueOnce(Response.json({ data: { project: { environments: { edges: [] } } } }))
    .mockResolvedValueOnce(
      Response.json({ data: { environmentCreate: { id: "isolated-staging" } } }),
    );
  vi.stubGlobal("fetch", fetch);
  await import("../../../infra/railway/sandbox-environment.mjs");
  vi.resetModules();
  vi.stubEnv("RAILWAY_ENVIRONMENT_ID", "staging");
  await import("../../../infra/railway/sandbox-environment.mjs");
  const production = JSON.parse(fetch.mock.calls[1]?.[1].body).variables.input.name;
  const staging = JSON.parse(fetch.mock.calls[3]?.[1].body).variables.input.name;
  expect(production).not.toBe(staging);
  expect(production).toMatch(/^sbx-[a-f0-9]{24}$/);
  expect(staging).toMatch(/^sbx-[a-f0-9]{24}$/);
});
