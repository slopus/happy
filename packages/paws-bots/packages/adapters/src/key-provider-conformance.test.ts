import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { KMSClient } from "@aws-sdk/client-kms";
import type { KeyProvider } from "@rakazo/adapter-kit";
import { LocalKeyProvider, withLocalMasterKeys } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AwsKmsKeyProvider, awsKmsConfigFromEnv } from "./aws-kms-key-provider.js";
import { contentKeyProviderFromEnv } from "./key-provider-factory.js";
import { unwrapEnv, wrapEnvValue } from "./wrapped-env.js";

const KEY_ARN = "arn:aws:kms:eu-central-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab";
const NEXT_KEY_ARN =
  "arn:aws:kms:eu-central-1:111122223333:key/5678efgh-56ef-78gh-90ij-5678901234ef";
const KEYS = [KEY_ARN, NEXT_KEY_ARN];
const config = {
  keyArn: KEY_ARN,
  accessKeyId: "fake-access-key",
  secretAccessKey: "fake-secret-key",
};
const kmsEnv = {
  AWS_KMS_KEY_ARN: KEY_ARN,
  AWS_KMS_ACCESS_KEY_ID: "fake-access-key",
  AWS_KMS_SECRET_ACCESS_KEY: "fake-secret-key",
};

/**
 * Just enough of the KMS JSON protocol to exercise the adapter offline: Encrypt and
 * Decrypt under the keys in `KEYS`, with the encryption context authenticated and the
 * key recorded in the ciphertext like KMS does. Signatures are not checked.
 */
function fakeKms() {
  const keys = KEYS.map(() => randomBytes(32));
  const state = { down: false, contexts: [] as Record<string, string>[] };
  const aad = (context: Record<string, string> = {}) =>
    Buffer.from(JSON.stringify(Object.entries(context).sort(([a], [b]) => a.localeCompare(b))));
  const server = createServer(async (req, res) => {
    // A local tool can probe any listening loopback port; only KMS calls are recorded.
    if (req.method !== "POST" || typeof req.headers["x-amz-target"] !== "string") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const send = (status: number, body: object) => {
      res.writeHead(status, { "content-type": "application/x-amz-json-1.1" });
      res.end(JSON.stringify(body));
    };
    const fail = (type: string) => send(400, { __type: type, message: type });
    if (state.down) return send(500, { __type: "KMSInternalException", message: "down" });
    state.contexts.push(input.EncryptionContext);
    const action = req.headers["x-amz-target"];
    if (action === "TrentService.Encrypt") {
      const index = KEYS.indexOf(input.KeyId);
      if (index < 0) return fail("NotFoundException");
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", keys[index]!, iv);
      cipher.setAAD(aad(input.EncryptionContext));
      const body = Buffer.concat([
        cipher.update(Buffer.from(input.Plaintext, "base64")),
        cipher.final(),
      ]);
      const blob = Buffer.concat([Buffer.from([index]), iv, body, cipher.getAuthTag()]);
      return send(200, { CiphertextBlob: blob.toString("base64"), KeyId: input.KeyId });
    }
    if (action === "TrentService.Decrypt") {
      const blob = Buffer.from(input.CiphertextBlob, "base64");
      const keyArn = KEYS[blob[0]!];
      if (!keyArn) return fail("InvalidCiphertextException");
      if (input.KeyId && input.KeyId !== keyArn) return fail("IncorrectKeyException");
      try {
        const decipher = createDecipheriv("aes-256-gcm", keys[blob[0]!]!, blob.subarray(1, 13));
        decipher.setAAD(aad(input.EncryptionContext));
        decipher.setAuthTag(blob.subarray(blob.length - 16));
        const plain = Buffer.concat([
          decipher.update(blob.subarray(13, blob.length - 16)),
          decipher.final(),
        ]);
        return send(200, { Plaintext: plain.toString("base64"), KeyId: keyArn });
      } catch {
        return fail("InvalidCiphertextException");
      }
    }
    return fail("UnknownOperationException");
  });
  return { server, state };
}

const kms = fakeKms();
let client: KMSClient;
beforeAll(async () => {
  await new Promise<void>((resolve) => kms.server.listen(0, "127.0.0.1", resolve));
  client = new KMSClient({
    region: "eu-central-1",
    endpoint: `http://127.0.0.1:${(kms.server.address() as AddressInfo).port}`,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    maxAttempts: 1,
  });
});
afterAll(async () => {
  client.destroy();
  await new Promise((resolve) => kms.server.close(resolve));
});

const local = () => new LocalKeyProvider([{ id: "k1", key: randomBytes(32) }]);
const aws = () => new AwsKmsKeyProvider(config, client);

function conformance(name: string, create: () => KeyProvider) {
  describe(`${name} KeyProvider conformance`, () => {
    const context = { spaceId: "space-a", version: 1 };

    it("unwraps what it wraps, under the active key, without revealing the data key", async () => {
      const provider = create();
      const dataKey = randomBytes(32);
      const wrapped = await provider.wrap(dataKey, context);
      expect(wrapped.masterKeyId).toBe(provider.activeKeyId());
      expect(wrapped.wrappedKey).not.toContain(dataKey.toString("base64url"));
      expect(Buffer.from(await provider.unwrap(wrapped, context))).toEqual(dataKey);
      expect((await provider.wrap(dataKey, context)).wrappedKey).not.toBe(wrapped.wrappedKey);
    });

    it("binds the wrap to its space and version", async () => {
      const provider = create();
      const wrapped = await provider.wrap(randomBytes(32), context);
      await expect(provider.unwrap(wrapped, { ...context, spaceId: "space-b" })).rejects.toThrow();
      await expect(provider.unwrap(wrapped, { ...context, version: 2 })).rejects.toThrow();
      // A member's account vault key is scoped to the member, beside the space keys.
      const member = { spaceId: "user:user-a", version: 1 };
      const dataKey = randomBytes(32);
      const vault = await provider.wrap(dataKey, member);
      expect(Buffer.from(await provider.unwrap(vault, member))).toEqual(dataKey);
      await expect(provider.unwrap(vault, { ...member, spaceId: "user:user-b" })).rejects.toThrow();
      await expect(provider.unwrap(vault, context)).rejects.toThrow();
    });

    it("rejects tampered wraps and unknown master keys", async () => {
      const provider = create();
      const wrapped = await provider.wrap(randomBytes(32), context);
      const bytes = Buffer.from(wrapped.wrappedKey, "base64url");
      bytes[bytes.length - 1]! ^= 1;
      await expect(
        provider.unwrap({ ...wrapped, wrappedKey: bytes.toString("base64url") }, context),
      ).rejects.toThrow();
      await expect(
        provider.unwrap({ ...wrapped, masterKeyId: "missing" }, context),
      ).rejects.toThrow();
    });
  });
}

conformance("local", local);
conformance("AWS KMS", aws);
conformance("AWS KMS with local master keys", () => withLocalMasterKeys(aws(), local()));

describe("AWS KMS key provider", () => {
  it("sends the space and version as encryption context", async () => {
    kms.state.contexts.length = 0;
    await aws().wrap(randomBytes(32), { spaceId: "space-a", version: 3 });
    expect(kms.state.contexts).toEqual([
      { "rakazo:purpose": "space-key/v1", "rakazo:space": "space-a", "rakazo:version": "3" },
    ]);
  });

  it("names the master key and keeps the cause when KMS is unavailable", async () => {
    const provider = aws();
    const wrapped = await provider.wrap(randomBytes(32), { spaceId: "s", version: 1 });
    kms.state.down = true;
    try {
      const error = await provider.unwrap(wrapped, { spaceId: "s", version: 1 }).catch((e) => e);
      expect(error.message).toBe(
        "Space key could not be unwrapped with master key aws-kms:1234abcd-12ab-34cd-56ef-1234567890ab",
      );
      expect(error.cause).toBeDefined();
    } finally {
      kms.state.down = false;
    }
  });

  it("reads its configuration from the environment and needs a key ARN", () => {
    expect(awsKmsConfigFromEnv(kmsEnv)).toEqual(config);
    expect(() => awsKmsConfigFromEnv({ ...kmsEnv, AWS_KMS_SECRET_ACCESS_KEY: "" })).toThrow(
      "AWS_KMS_SECRET_ACCESS_KEY",
    );
    expect(awsKmsConfigFromEnv({ AWS_KMS_KEY_ARN: KEY_ARN, AWS_KMS_PROFILE: "fake" })).toEqual({
      keyArn: KEY_ARN,
      profile: "fake",
    });
    expect(() => awsKmsConfigFromEnv({ ...kmsEnv, AWS_KMS_PROFILE: "fake" })).toThrow(
      "AWS_KMS_PROFILE",
    );
    expect(() => awsKmsConfigFromEnv({ AWS_KMS_KEY_ARN: KEY_ARN })).toThrow("AWS_KMS_PROFILE");
    const alias = "arn:aws:kms:eu-central-1:111122223333:alias/rakazo";
    expect(() => new AwsKmsKeyProvider({ ...config, keyArn: alias })).toThrow("AWS_KMS_KEY_ARN");
  });
});

describe("wrapped environment values under AWS KMS", () => {
  it("binds the variable name into the KMS encryption context", async () => {
    const env = { BETTER_AUTH_SECRET: await wrapEnvValue(aws(), "BETTER_AUTH_SECRET", "fake") };
    expect(kms.state.contexts.at(-1)).toMatchObject({ "rakazo:space": "env:BETTER_AUTH_SECRET" });
    await unwrapEnv(env, aws());
    expect(env.BETTER_AUTH_SECRET).toBe("fake");
  });
});

describe("moving space keys to a key manager", () => {
  it("wraps new keys with KMS while locally wrapped keys still unwrap", async () => {
    const env = local();
    const context = { spaceId: "space-a", version: 1 };
    const dataKey = randomBytes(32);
    const old = await env.wrap(dataKey, context);
    const provider = withLocalMasterKeys(aws(), env);
    expect(Buffer.from(await provider.unwrap(old, context))).toEqual(dataKey);
    // What `content-encryption rotate` does with each stored key.
    const moved = await provider.wrap(await provider.unwrap(old, context), context);
    expect(moved.masterKeyId).toBe("aws-kms:1234abcd-12ab-34cd-56ef-1234567890ab");
    expect(Buffer.from(await provider.unwrap(moved, context))).toEqual(dataKey);
  });

  it("moves keys from a replaced KMS key to the new one", async () => {
    const context = { spaceId: "space-a", version: 1 };
    const dataKey = randomBytes(32);
    const old = await aws().wrap(dataKey, context);
    const next = new AwsKmsKeyProvider({ ...config, keyArn: NEXT_KEY_ARN }, client);
    const moved = await next.wrap(await next.unwrap(old, context), context);
    expect(moved.masterKeyId).toBe("aws-kms:5678efgh-56ef-78gh-90ij-5678901234ef");
    expect(Buffer.from(await next.unwrap(moved, context))).toEqual(dataKey);
    // A stored key naming one KMS key cannot be swapped for a wrap under another.
    await expect(
      next.unwrap({ ...old, masterKeyId: moved.masterKeyId }, context),
    ).rejects.toThrow();
    await expect(next.unwrap({ ...old, masterKeyId: "aws-kms:other" }, context)).rejects.toThrow(
      "with a key other than aws-kms:other",
    );
  });

  it("is selected by MASTER_KEY_PROVIDER, failing at startup on bad configuration", () => {
    expect(contentKeyProviderFromEnv({})).toBeUndefined();
    expect(contentKeyProviderFromEnv({ MASTER_KEY_PROVIDER: "local" })).toBeUndefined();
    expect(() => contentKeyProviderFromEnv({ MASTER_KEY_PROVIDER: "vault" })).toThrow(
      "Unsupported MASTER_KEY_PROVIDER",
    );
    expect(() =>
      contentKeyProviderFromEnv({ MASTER_KEY_PROVIDER: "aws-kms", AWS_KMS_KEY_ARN: "" }),
    ).toThrow("AWS_KMS_");
    expect(() =>
      contentKeyProviderFromEnv({ ...kmsEnv, MASTER_KEY_PROVIDER: "aws-kms", AWS_KMS_KEY_ARN: "" }),
    ).toThrow("AWS_KMS_KEY_ARN");
    const provider = contentKeyProviderFromEnv({
      ...kmsEnv,
      MASTER_KEY_PROVIDER: "aws-kms",
      ENCRYPTION_KEY: "fake-encryption-key-for-tests-0000000000000000000000000000",
    });
    expect(provider?.activeKeyId()).toBe("aws-kms:1234abcd-12ab-34cd-56ef-1234567890ab");
  });
});
