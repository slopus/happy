import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { KeyProvider, KeyWrapContext } from "@rakazo/adapter-kit";

const PREFIX = "wrapped:v1:";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * The variable name is part of the wrap context and the value's associated data, so a
 * wrapped value copied into another variable fails to unwrap. The `env:` prefix keeps it
 * apart from space ids.
 */
function wrapContext(name: string): KeyWrapContext {
  return { spaceId: `env:${name}`, version: 1 };
}

/** Envelope encryption: a fresh data key seals the value, and the key provider wraps it. */
export async function wrapEnvValue(
  provider: KeyProvider,
  name: string,
  value: string,
): Promise<string> {
  const dataKey = randomBytes(32);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
  cipher.setAAD(Buffer.from(name));
  const sealed = Buffer.concat([
    iv,
    cipher.update(value, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const { masterKeyId, wrappedKey } = await provider.wrap(dataKey, wrapContext(name));
  return `${PREFIX}${Buffer.from(masterKeyId).toString("base64url")}.${wrappedKey}.${sealed.toString("base64url")}`;
}

async function unwrapEnvValue(provider: KeyProvider, name: string, wrapped: string) {
  const [masterKeyId, wrappedKey, sealed, ...rest] = wrapped.slice(PREFIX.length).split(".");
  const bytes = Buffer.from(sealed ?? "", "base64url");
  if (!masterKeyId || !wrappedKey || rest.length || bytes.length < IV_BYTES + TAG_BYTES)
    throw new Error(`${name} is not a valid wrapped value`);
  try {
    const dataKey = await provider.unwrap(
      { masterKeyId: Buffer.from(masterKeyId, "base64url").toString(), wrappedKey },
      wrapContext(name),
    );
    const decipher = createDecipheriv("aes-256-gcm", dataKey, bytes.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(name));
    decipher.setAuthTag(bytes.subarray(-TAG_BYTES));
    return Buffer.concat([
      decipher.update(bytes.subarray(IV_BYTES, -TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    throw new Error(`${name} could not be unwrapped`, { cause: error });
  }
}

/**
 * Replaces every wrapped value in `env` with its plaintext. Plain values are left alone;
 * a wrapped value with no key provider to unwrap it stops startup.
 */
export async function unwrapEnv(
  env: NodeJS.ProcessEnv,
  provider: KeyProvider | undefined,
): Promise<void> {
  const names = Object.keys(env).filter((name) => isWrappedEnvValue(env[name]));
  if (!names.length) return;
  if (!provider)
    throw new Error(`Wrapped values need MASTER_KEY_PROVIDER to unwrap them: ${names.join(", ")}`);
  const values = await Promise.all(
    names.map((name) => unwrapEnvValue(provider, name, env[name] ?? "")),
  );
  names.forEach((name, index) => {
    env[name] = values[index];
  });
}

export function isWrappedEnvValue(value: string | undefined): boolean {
  return value?.startsWith(PREFIX) ?? false;
}
