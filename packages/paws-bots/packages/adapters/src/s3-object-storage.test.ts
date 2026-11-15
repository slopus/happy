import { createServer, Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import type { AddressInfo } from "node:net";
import type * as S3Sdk from "@aws-sdk/client-s3";
import { S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryObjectStorage, objectStorageConformance } from "./object-storage.test-support.js";
import {
  objectStorageConfigFromEnv,
  objectStorageRequestHandler,
  S3ObjectStorage,
} from "./s3-object-storage.js";

const clientConfigs = vi.hoisted(() => [] as unknown[]);
vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const sdk = await importOriginal<typeof S3Sdk>();
  class S3Client extends sdk.S3Client {
    constructor(...args: ConstructorParameters<typeof sdk.S3Client>) {
      clientConfigs.push(args[0]);
      super(...args);
    }
  }
  return { ...sdk, S3Client };
});

/**
 * Just enough of the S3 protocol, path-style, to exercise the adapter offline: single and
 * multipart uploads, reads, paged listings and batch deletes. Signatures are not checked.
 */
function fakeS3() {
  const objects = new Map<string, { body: Buffer; lastModified: Date }>();
  const uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  const requests: string[] = [];
  let nextUpload = 0;
  const xml = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const server = createServer(async (req, res) => {
    // Local tools can probe any listening loopback port; every S3 call names a bucket.
    if (req.url === "/") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", "http://fake");
    const [, bucket, ...rest] = url.pathname.split("/");
    const key = decodeURIComponent(rest.join("/"));
    const query = url.searchParams;
    const send = (status: number, payload: string | Buffer = "", headers = {}) => {
      res.writeHead(status, headers);
      res.end(payload);
    };
    const named = [...query.keys()].filter((name) => name !== "x-id").sort();
    requests.push(
      `${req.method} ${key ? "object" : "bucket"}${named.length ? `?${named.join("&")}` : ""}`,
    );
    if (bucket !== "test-bucket") return send(404, "<Error><Code>NoSuchBucket</Code></Error>");
    if (req.method === "PUT" && query.has("uploadId")) {
      uploads.get(query.get("uploadId")!)!.parts.set(Number(query.get("partNumber")), body);
      return send(200, "", { ETag: `"part-${query.get("partNumber")}"` });
    }
    if (req.method === "PUT") {
      objects.set(key, { body, lastModified: new Date() });
      return send(200, "", { ETag: '"object"' });
    }
    if (req.method === "POST" && query.has("uploads")) {
      const uploadId = `upload-${++nextUpload}`;
      uploads.set(uploadId, { key, parts: new Map() });
      return send(
        200,
        `<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${xml(key)}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
      );
    }
    if (req.method === "POST" && query.has("uploadId")) {
      const upload = uploads.get(query.get("uploadId")!)!;
      const numbers = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map(
        (match) => Number(match[1]),
      );
      objects.set(upload.key, {
        body: Buffer.concat(numbers.map((number) => upload.parts.get(number)!)),
        lastModified: new Date(),
      });
      uploads.delete(query.get("uploadId")!);
      return send(
        200,
        `<CompleteMultipartUploadResult><Key>${xml(upload.key)}</Key><ETag>"done"</ETag></CompleteMultipartUploadResult>`,
      );
    }
    if (req.method === "DELETE" && query.has("uploadId")) {
      uploads.delete(query.get("uploadId")!);
      return send(204);
    }
    if (req.method === "POST" && query.has("delete")) {
      for (const match of body.toString().matchAll(/<Key>([^<]*)<\/Key>/g))
        objects.delete(
          match[1]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"),
        );
      return send(200, "<DeleteResult></DeleteResult>");
    }
    if (req.method === "GET" && !key && query.get("list-type") === "2") {
      // Two keys a page, so the adapter has to follow continuation tokens.
      const prefix = query.get("prefix") ?? "";
      const all = [...objects.keys()].filter((name) => name.startsWith(prefix)).sort();
      const start = Number(query.get("continuation-token") ?? 0);
      const page = all.slice(start, start + 2);
      const truncated = start + 2 < all.length;
      return send(
        200,
        `<ListBucketResult><Name>${bucket}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><IsTruncated>${truncated}</IsTruncated>${
          truncated ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ""
        }${page
          .map(
            (name) =>
              `<Contents><Key>${xml(name)}</Key><LastModified>${objects.get(name)!.lastModified.toISOString()}</LastModified><Size>${objects.get(name)!.body.length}</Size></Contents>`,
          )
          .join("")}</ListBucketResult>`,
      );
    }
    if (req.method === "GET") {
      const object = objects.get(key);
      if (!object)
        return send(404, "<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>");
      return send(200, object.body, { "Content-Length": object.body.length });
    }
    send(400, "<Error><Code>BadRequest</Code></Error>");
  });
  return { server, objects, requests };
}

const fake = fakeS3();
let endpoint = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => fake.server.close(resolve));
});

function storage(prefix = "") {
  return new S3ObjectStorage({
    bucket: "test-bucket",
    endpoint,
    region: "us-east-1",
    accessKeyId: "fake-access-key",
    secretAccessKey: "fake-secret-key",
    prefix,
    pathStyle: true,
  });
}

let run = 0;
describe("S3ObjectStorage", () => {
  objectStorageConformance(async () => storage(`run-${++run}/`));

  it("keeps every object under the configured prefix", async () => {
    await storage("deployment-a/").put(
      "homes/x/1",
      (async function* () {
        yield Buffer.from("x");
      })(),
    );
    expect(fake.objects.has("deployment-a/homes/x/1")).toBe(true);
    const listed: string[] = [];
    for await (const object of storage("deployment-b/").list("homes/")) listed.push(object.key);
    expect(listed).toEqual([]);
  });

  it("uploads a small home in one request and a large one in parts", async () => {
    fake.requests.length = 0;
    await storage("requests/").put(
      "small",
      (async function* () {
        yield Buffer.alloc(1024);
      })(),
    );
    expect(fake.requests).toEqual(["PUT object"]);

    fake.requests.length = 0;
    await storage("requests/").put(
      "large",
      (async function* () {
        for (let index = 0; index < 33; index += 1) yield Buffer.alloc(1024 * 1024, index);
      })(),
    );
    expect(fake.requests).toEqual([
      "POST object?uploads",
      "PUT object?partNumber&uploadId",
      "PUT object?partNumber&uploadId",
      "PUT object?partNumber&uploadId",
      "POST object?uploadId",
    ]);
  });

  it("aborts a multipart upload when the source fails", async () => {
    fake.requests.length = 0;
    await expect(
      storage("abort/").put(
        "broken",
        (async function* () {
          yield Buffer.alloc(40 * 1024 * 1024);
          throw new Error("source failed");
        })(),
      ),
    ).rejects.toThrow("source failed");
    expect(fake.requests.at(-1)).toBe("DELETE object?uploadId");
    expect([...fake.objects.keys()].some((key) => key.startsWith("abort/"))).toBe(false);
  });
});

describe("S3ObjectStorage failures", () => {
  it("closes the source when the upload cannot start", async () => {
    let closed = false;
    const missingBucket = new S3ObjectStorage({
      bucket: "missing-bucket",
      endpoint,
      region: "us-east-1",
      accessKeyId: "fake-access-key",
      secretAccessKey: "fake-secret-key",
      prefix: "",
      pathStyle: true,
    });
    await expect(
      missingBucket.put(
        "big",
        (async function* () {
          try {
            for (;;) yield Buffer.alloc(8 * 1024 * 1024);
          } finally {
            closed = true;
          }
        })(),
      ),
    ).rejects.toThrow();
    expect(closed).toBe(true);
  });
});

describe("S3ObjectStorage timeouts", () => {
  const IDLE_MS = 1000;
  const slow = createServer((req, res) => {
    req.resume();
    const key = new URL(req.url ?? "/", "http://fake").pathname.split("/").slice(2).join("/");
    if (!key) {
      // A listing whose headers and first bytes arrive, then nothing.
      res.writeHead(200, { "content-type": "application/xml" });
      res.write("<ListBucketResult><Name>slow-bucket</Name><Contents><Key>a</Key>");
      return;
    }
    if (key === "stalled") {
      res.writeHead(200, { "content-length": "1000" });
      res.write(Buffer.alloc(100));
      return;
    }
    if (key === "large" || key === "late-headers") {
      // The SDK arms its own socket timeout when headers take longer than 3 s.
      setTimeout(
        () => {
          res.writeHead(200, { "content-length": String(LARGE_BYTES) });
          res.end(Buffer.alloc(LARGE_BYTES, 1));
        },
        key === "large" ? 0 : 3_500,
      );
      return;
    }
    // Busy but healthy: a byte every 100 ms, longer than the idle limit in total.
    res.writeHead(200, { "content-length": "35" });
    let sent = 0;
    const tick = setInterval(() => {
      res.write("x");
      if (++sent === 35) {
        clearInterval(tick);
        res.end();
      }
    }, 100);
    res.on("close", () => clearInterval(tick));
  });
  const LARGE_BYTES = 8 * 1024 * 1024;
  let slowStorage: S3ObjectStorage;

  function slowClient(requestHandler: NonNullable<S3Sdk.S3ClientConfig["requestHandler"]>) {
    const client = new S3Client({
      region: "us-east-1",
      endpoint: `http://127.0.0.1:${(slow.address() as AddressInfo).port}`,
      forcePathStyle: true,
      credentials: { accessKeyId: "fake-access-key", secretAccessKey: "fake-secret-key" },
      requestHandler,
    });
    return new S3ObjectStorage(
      {
        bucket: "slow-bucket",
        region: "us-east-1",
        accessKeyId: "fake-access-key",
        secretAccessKey: "fake-secret-key",
        prefix: "",
        pathStyle: true,
      },
      client,
    );
  }

  beforeAll(async () => {
    await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
    // A short idle limit on the sockets; the SDK's own layer keeps the production value.
    slowStorage = slowClient({ ...objectStorageRequestHandler(IDLE_MS), socketTimeout: 60_000 });
  });

  afterAll(async () => {
    slow.closeAllConnections();
    await new Promise((resolve) => slow.close(resolve));
  });

  async function read(key: string, pauseMs = 0, from = slowStorage) {
    let bytes = 0;
    for await (const chunk of from.get(key)) {
      if (bytes === 0 && pauseMs) await new Promise((resolve) => setTimeout(resolve, pauseMs));
      bytes += chunk.length;
    }
    return bytes;
  }

  it("creates its client with sockets that give up when the store goes quiet", async () => {
    clientConfigs.length = 0;
    for await (const _ of storage(`timeouts-${++run}/`).list("")) {
      // Listing creates the client.
    }
    const [config] = clientConfigs as Array<{ requestHandler?: unknown }>;
    // The agents own every socket's inactivity limit; the SDK gets no timeout of its own.
    expect(config?.requestHandler).toEqual({
      httpAgent: expect.any(HttpAgent),
      httpsAgent: expect.any(HttpsAgent),
    });
  });

  it("fails a listing whose body stops after the headers", async () => {
    await expect(
      (async () => {
        for await (const _ of slowStorage.list("")) {
          // Never reached.
        }
      })(),
    ).rejects.toThrow();
  });

  it("fails a read whose body stops after the headers", async () => {
    await expect(read("stalled")).rejects.toThrow();
  });

  it("keeps a read whose reader pauses longer than the idle limit", async () => {
    await expect(read("large", IDLE_MS * 2.5)).resolves.toBe(LARGE_BYTES);
  });

  it("keeps a read whose headers were slow and whose reader then pauses", async () => {
    // Headers after 3.5 s make the SDK arm a socket timeout of its own (here 6 s, armed for the
    // 3 s left); the idle limit is longer than the wait for headers and shorter than the pause.
    const late = slowClient({ ...objectStorageRequestHandler(4_000), socketTimeout: 6_000 });
    await expect(read("late-headers", 5_000, late)).resolves.toBe(LARGE_BYTES);
  }, 20_000);

  it("does not fail a request for waiting on a busy socket pool", async () => {
    // Fifty reads take every pooled socket for 3.5 s, over three idle periods; the next waits.
    const busy = Array.from({ length: 50 }, (_, index) => read(`busy-${index}`));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(read("queued")).resolves.toBe(35);
    await expect(Promise.all(busy)).resolves.toHaveLength(50);
  });
});

describe("MemoryObjectStorage", () => {
  objectStorageConformance(async () => new MemoryObjectStorage());
});

describe("objectStorageConfigFromEnv", () => {
  it("is off without a bucket", () => {
    expect(objectStorageConfigFromEnv({})).toBeUndefined();
  });

  it("requires its own credentials", () => {
    expect(() =>
      objectStorageConfigFromEnv({ OBJECT_STORAGE_BUCKET: "b", AWS_ACCESS_KEY_ID: "x" }),
    ).toThrow(/OBJECT_STORAGE_ACCESS_KEY_ID/);
  });

  it("reads a generic S3-compatible connection", () => {
    expect(
      objectStorageConfigFromEnv({
        OBJECT_STORAGE_BUCKET: "homes",
        OBJECT_STORAGE_ENDPOINT: "https://storage.example.invalid",
        OBJECT_STORAGE_ACCESS_KEY_ID: "id",
        OBJECT_STORAGE_SECRET_ACCESS_KEY: "secret",
        OBJECT_STORAGE_PREFIX: "/rakazo/",
        OBJECT_STORAGE_PATH_STYLE: "true",
      }),
    ).toEqual({
      bucket: "homes",
      endpoint: "https://storage.example.invalid",
      region: "us-east-1",
      accessKeyId: "id",
      secretAccessKey: "secret",
      prefix: "rakazo/",
      pathStyle: true,
    });
  });

  it("rejects malformed settings", () => {
    const base = {
      OBJECT_STORAGE_BUCKET: "b",
      OBJECT_STORAGE_ACCESS_KEY_ID: "id",
      OBJECT_STORAGE_SECRET_ACCESS_KEY: "secret",
    };
    expect(() =>
      objectStorageConfigFromEnv({ ...base, OBJECT_STORAGE_ENDPOINT: "storage.example.invalid" }),
    ).toThrow(/http/);
    expect(() => objectStorageConfigFromEnv({ ...base, OBJECT_STORAGE_PATH_STYLE: "yes" })).toThrow(
      /PATH_STYLE/,
    );
  });
});
