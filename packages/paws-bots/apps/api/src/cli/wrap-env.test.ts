import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { unwrapEnv } from "@rakazo/adapters";
import { LocalKeyProvider } from "@rakazo/db";
import { afterEach, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("@rakazo/core/node/load-root-env", () => ({ loadRootEnv: () => {} }));
vi.mock("@rakazo/adapters", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  keyManagerFromEnv: () => provider.current,
}));

const argv = process.argv;
const stdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
afterEach(() => {
  process.argv = argv;
  Object.defineProperty(process, "stdin", stdin);
  vi.restoreAllMocks();
});

it("wraps the value it reads from stdin for the named variable", async () => {
  const keys = new LocalKeyProvider([{ id: "k1", key: randomBytes(32) }]);
  provider.current = keys;
  process.argv = [argv[0]!, "wrap-env", "BETTER_AUTH_SECRET"];
  Object.defineProperty(process, "stdin", { value: Readable.from(["fake-secret\n"]) });
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await import("./wrap-env.js");
  const env = { BETTER_AUTH_SECRET: String(write.mock.calls[0]?.[0]).trim() };
  await unwrapEnv(env, keys);
  expect(env.BETTER_AUTH_SECRET).toBe("fake-secret");
});
