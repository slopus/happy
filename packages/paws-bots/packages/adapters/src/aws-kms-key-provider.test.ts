import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type * as KmsSdk from "@aws-sdk/client-kms";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { AwsKmsKeyProvider } from "./aws-kms-key-provider.js";

const kms = vi.hoisted(() => ({ endpoint: "", maxAttempts: 1, requestTimeout: 200 }));

// Keeps the provider's client settings, pointed at a local KMS and with a shorter request
// limit so the test stays fast.
vi.mock("@aws-sdk/client-kms", async (importOriginal) => {
  const sdk = await importOriginal<typeof KmsSdk>();
  class KMSClient extends sdk.KMSClient {
    constructor(config: KmsSdk.KMSClientConfig) {
      const requestHandler = config.requestHandler as Record<string, unknown>;
      super({
        ...config,
        endpoint: kms.endpoint,
        maxAttempts: kms.maxAttempts,
        requestHandler: { ...requestHandler, requestTimeout: kms.requestTimeout },
      });
    }
  }
  return { ...sdk, KMSClient };
});

const silent = createServer(() => {
  // Accepts the request and never answers.
});
const stalled = createServer((_request, response) => {
  // Sends the headers and the start of the body, then stops without closing.
  response.writeHead(200, { "content-type": "application/x-amz-json-1.1", "content-length": "64" });
  response.write('{"CiphertextBlob":"');
});
let slowRequests = 0;
const slow = createServer((_request, response) => {
  // The first two attempts get no answer; the third answers well within its request limit.
  if (++slowRequests <= 2) return;
  setTimeout(() => {
    response.writeHead(200, { "content-type": "application/x-amz-json-1.1" });
    response.end(JSON.stringify({ CiphertextBlob: Buffer.from("wrapped").toString("base64") }));
  }, 300);
});
let ports: { silent: number; stalled: number; slow: number };

beforeAll(async () => {
  for (const server of [silent, stalled, slow])
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  ports = {
    silent: (silent.address() as AddressInfo).port,
    stalled: (stalled.address() as AddressInfo).port,
    slow: (slow.address() as AddressInfo).port,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(kms, { maxAttempts: 1, requestTimeout: 200 });
});

afterAll(async () => {
  for (const server of [silent, stalled, slow]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

function provider(port: number) {
  kms.endpoint = `http://127.0.0.1:${port}`;
  return new AwsKmsKeyProvider({
    keyArn: "arn:aws:kms:eu-west-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab",
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
  });
}

const context = { spaceId: "space-1", version: 1 };

it("gives up on a KMS that stops answering instead of waiting forever", async () => {
  await expect(provider(ports.silent).wrap(new Uint8Array(32), context)).rejects.toThrow(
    /requestTimeout/,
  );
}, 3_000);

it("gives up on a KMS that stops sending the response body", async () => {
  // A shorter deadline than the provider's so the test stays fast.
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(300));
  const kmsProvider = provider(ports.stalled);

  await expect(kmsProvider.wrap(new Uint8Array(32), context)).rejects.toThrow(/aborted/);
  const unwrap = kmsProvider.unwrap(
    { masterKeyId: kmsProvider.activeKeyId(), wrappedKey: "AAAA" },
    context,
  );
  await expect(unwrap).rejects.toThrow(/could not be unwrapped/);
  await expect(unwrap.catch((error: Error) => Promise.reject(error.cause))).rejects.toThrow(
    /aborted/,
  );
}, 3_000);

it("leaves the deadline room for every attempt and its backoff", async () => {
  // Every limit runs 20 times faster than in production: 10 s requests take 500 ms here.
  Object.assign(kms, { maxAttempts: 3, requestTimeout: 500 });
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => timeout(ms / 20));
  // The longest backoff the SDK draws between attempts.
  vi.spyOn(Math, "random").mockReturnValue(0.999);

  await expect(provider(ports.slow).wrap(new Uint8Array(32), context)).resolves.toMatchObject({
    wrappedKey: Buffer.from("wrapped").toString("base64url"),
  });
  expect(slowRequests).toBe(3);
}, 5_000);
