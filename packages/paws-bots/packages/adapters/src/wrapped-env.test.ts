import { randomBytes } from "node:crypto";
import { LocalKeyProvider } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { unwrapEnvFromKeyManager } from "./key-provider-factory.js";
import { unwrapEnv, wrapEnvValue } from "./wrapped-env.js";

const provider = new LocalKeyProvider([{ id: "k1", key: randomBytes(32) }]);
const SECRET = "fake-auth-secret-with-unicode-é-and=signs";

describe("wrapped environment values", () => {
  it("unwraps in place and leaves plain values alone", async () => {
    const wrapped = await wrapEnvValue(provider, "BETTER_AUTH_SECRET", SECRET);
    expect(wrapped).toMatch(/^wrapped:v1:/);
    expect(wrapped).not.toContain(SECRET);
    const env = { BETTER_AUTH_SECRET: wrapped, PLAIN_KEY: "fake-plain-value" };
    await unwrapEnv(env, provider);
    expect(env).toEqual({ BETTER_AUTH_SECRET: SECRET, PLAIN_KEY: "fake-plain-value" });
  });

  it("rejects a value moved to another variable", async () => {
    const env = { OTHER_SECRET: await wrapEnvValue(provider, "BETTER_AUTH_SECRET", SECRET) };
    await expect(unwrapEnv(env, provider)).rejects.toThrow("OTHER_SECRET could not be unwrapped");
  });

  it("rejects a tampered value without echoing it", async () => {
    const wrapped = await wrapEnvValue(provider, "BETTER_AUTH_SECRET", SECRET);
    const tampered = `${wrapped.slice(0, -2)}${wrapped.at(-2) === "A" ? "B" : "A"}${wrapped.slice(-1)}`;
    for (const value of [tampered, `${wrapped}.extra`, "wrapped:v1:"]) {
      await expect(unwrapEnv({ BETTER_AUTH_SECRET: value }, provider)).rejects.toThrow(
        /^BETTER_AUTH_SECRET (could not be unwrapped|is not a valid wrapped value)$/,
      );
    }
  });

  it("fails closed when nothing can unwrap", async () => {
    const env = { BETTER_AUTH_SECRET: await wrapEnvValue(provider, "BETTER_AUTH_SECRET", SECRET) };
    await expect(unwrapEnv(env, undefined)).rejects.toThrow(
      "Wrapped values need MASTER_KEY_PROVIDER to unwrap them: BETTER_AUTH_SECRET",
    );
    await expect(unwrapEnvFromKeyManager({ ...env, MASTER_KEY_PROVIDER: "local" })).rejects.toThrow(
      "BETTER_AUTH_SECRET",
    );
    await expect(unwrapEnv({ PLAIN_KEY: "fake-plain-value" }, undefined)).resolves.toBeUndefined();
  });

  it("refuses to wrap the settings that build the key manager", async () => {
    const wrapped = await wrapEnvValue(provider, "AWS_KMS_SECRET_ACCESS_KEY", "fake");
    await expect(unwrapEnvFromKeyManager({ AWS_KMS_SECRET_ACCESS_KEY: wrapped })).rejects.toThrow(
      "Key manager settings cannot be wrapped: AWS_KMS_SECRET_ACCESS_KEY",
    );
  });
});
