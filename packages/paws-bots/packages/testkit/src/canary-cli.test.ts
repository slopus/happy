import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execSync: vi.fn(),
  mkdtemp: vi.fn(async () => "/fake-canary-data"),
  rm: vi.fn(async () => undefined),
  startPostgres: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execSync: mocks.execSync }));
vi.mock("node:fs/promises", () => ({ mkdtemp: mocks.mkdtemp, rm: mocks.rm }));
vi.mock("@rakazo/core/node/load-root-env", () => ({ loadRootEnv: vi.fn() }));
vi.mock("./cli/postgres.js", () => ({
  startPostgres: mocks.startPostgres,
  disposableDatabaseEnv: () => ({}),
}));

const credentialNames = [
  "E2B_API_KEY",
  "BOAT_API_KEY",
  "BOXD_API_KEY",
  "INSTABOX_API_KEY",
  "NOVITA_API_KEY",
  "CREATEOS_SANDBOX_API_KEY",
  "OPENROUTER_API_KEY",
];

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  for (const name of credentialNames) vi.stubEnv(name, "");
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

test.each(credentialNames.filter((name) => name !== "OPENROUTER_API_KEY"))(
  "runs the provider canaries with only %s",
  async (name) => {
    vi.stubEnv(name, "fake-canary-key");
    await import("./cli/canary.js");
    await vi.waitFor(() => expect(mocks.rm).toHaveBeenCalled());
    expect(process.exit).not.toHaveBeenCalled();
    expect(mocks.startPostgres).not.toHaveBeenCalled();
    expect(mocks.execSync).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("providers.canary.test.ts"),
      expect.objectContaining({
        env: expect.objectContaining({ [name]: "fake-canary-key", VERIFY_PROVIDERS: "1" }),
      }),
    );
  },
);

test("rejects missing credentials and lists CreateOS before starting any services", async () => {
  await import("./cli/canary.js");
  await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
  expect(console.error).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining("CREATEOS_SANDBOX_API_KEY") }),
  );
  expect(mocks.mkdtemp).not.toHaveBeenCalled();
  expect(mocks.startPostgres).not.toHaveBeenCalled();
  expect(mocks.execSync).not.toHaveBeenCalled();
});
