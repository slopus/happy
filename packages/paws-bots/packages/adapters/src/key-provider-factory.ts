import type { KeyProvider } from "@rakazo/adapter-kit";
import {
  LocalKeyProvider,
  lazyKeyProvider,
  masterKeysFromEnv,
  withLocalMasterKeys,
} from "@rakazo/db";
import { AwsKmsKeyProvider, awsKmsConfigFromEnv } from "./aws-kms-key-provider.js";
import { isWrappedEnvValue, unwrapEnv } from "./wrapped-env.js";

/** Settings that build the key provider, which must be readable before anything unwraps. */
export const KEY_PROVIDER_SETTINGS = [
  "MASTER_KEY_PROVIDER",
  "AWS_KMS_KEY_ARN",
  "AWS_KMS_ACCESS_KEY_ID",
  "AWS_KMS_SECRET_ACCESS_KEY",
  "AWS_KMS_PROFILE",
];

/** The external key manager alone, without the local master keys. */
export function keyManagerFromEnv(env: NodeJS.ProcessEnv = process.env): KeyProvider | undefined {
  const provider = env.MASTER_KEY_PROVIDER?.trim() || "local";
  if (provider === "local") return undefined;
  if (provider !== "aws-kms") throw new Error("Unsupported MASTER_KEY_PROVIDER");
  return new AwsKmsKeyProvider(awsKmsConfigFromEnv(env));
}

/**
 * `MASTER_KEY_PROVIDER` picks who wraps space keys. Undefined keeps createDb's default,
 * the local master keys. A key manager wraps new keys while local ones keep unwrapping.
 */
export function contentKeyProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): KeyProvider | undefined {
  // Configuration errors surface at startup; local master keys are read on first use.
  const external = keyManagerFromEnv(env);
  if (!external) return undefined;
  return lazyKeyProvider(() =>
    withLocalMasterKeys(external, new LocalKeyProvider(masterKeysFromEnv(env))),
  );
}

/**
 * Unwraps `wrapped:v1:` values with the configured key manager. Every server process
 * awaits this right after loading `.env`, before reading any setting.
 */
export async function unwrapEnvFromKeyManager(env: NodeJS.ProcessEnv = process.env) {
  const bootstrap = KEY_PROVIDER_SETTINGS.filter((name) => isWrappedEnvValue(env[name]));
  if (bootstrap.length)
    throw new Error(`Key manager settings cannot be wrapped: ${bootstrap.join(", ")}`);
  await unwrapEnv(env, keyManagerFromEnv(env));
}
