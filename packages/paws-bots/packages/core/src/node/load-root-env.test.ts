import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRootEnv } from "./load-root-env.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "rakazo-env-test-"));
  writeFileSync(path.join(root, ".env"), "RAKAZO_TEST_ENV_SENTINEL=fixture\nDATA_DIR=./data\n");
  vi.spyOn(process, "cwd").mockReturnValue(root);
  vi.stubEnv("RAKAZO_TEST_ENV_SENTINEL", undefined);
  vi.stubEnv("DATA_DIR", undefined);
  vi.stubEnv("VERIFY_PROVIDERS", undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("root environment loading", () => {
  it("does not import local configuration into test processes", () => {
    vi.stubEnv("NODE_ENV", "test");
    loadRootEnv();
    expect(process.env.RAKAZO_TEST_ENV_SENTINEL).toBeUndefined();
    expect(process.env.DATA_DIR).toBeUndefined();
  });

  it("loads development configuration and anchors relative data paths to its directory", () => {
    vi.stubEnv("NODE_ENV", "development");
    loadRootEnv();
    expect(process.env.RAKAZO_TEST_ENV_SENTINEL).toBe("fixture");
    expect(process.env.DATA_DIR).toBe(path.join(root, "data"));
  });

  it("reads no file when the host supplies the whole environment", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RAKAZO_ENV_FILE", "none");
    loadRootEnv();
    expect(process.env.RAKAZO_TEST_ENV_SENTINEL).toBeUndefined();
  });

  it("preserves configuration supplied by the caller", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("RAKAZO_TEST_ENV_SENTINEL", "caller");
    loadRootEnv();
    expect(process.env.RAKAZO_TEST_ENV_SENTINEL).toBe("caller");
  });

  it("loads configuration when a live verification explicitly opts in", () => {
    vi.stubEnv("NODE_ENV", "test");
    loadRootEnv({ allowInTests: true });
    expect(process.env.RAKAZO_TEST_ENV_SENTINEL).toBe("fixture");
  });
});
