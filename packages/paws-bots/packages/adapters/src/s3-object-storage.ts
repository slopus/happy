import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import type { Socket } from "node:net";
import type { Duplex, Readable } from "node:stream";
import type * as S3Sdk from "@aws-sdk/client-s3";
import type { ObjectStorage } from "@rakazo/adapter-kit";

/** Upload part size: large enough that most homes are one request, small enough to hold in memory. */
const PART_BYTES = 16 * 1024 * 1024;
const DELETE_BATCH = 1000;
/**
 * The SDK waits forever by default, and its own socket limit stops once response headers arrive,
 * so a store that stops answering, before or during a body, would keep each computer's sleep job,
 * and the maintenance slot it holds, waiting for good. Sockets therefore fail after this long
 * without traffic, from connect to the end of the body. It counts inactivity, not duration: a
 * large transfer keeps its socket busy.
 */
const IDLE_SOCKET_TIMEOUT_MS = 60_000;
/** The SDK's own default per origin. */
const MAX_SOCKETS = 50;

/**
 * Makes this the only owner of the socket's inactivity timer. The SDK and Node's agent call
 * `setTimeout` on sockets to re-arm the timer, turn it off, or attach a callback that destroys the
 * socket even while its reader has paused it; those calls do nothing here, and the timeout event
 * reaches only this handler.
 */
function failWhenIdle<T extends Duplex | null | undefined>(socket: T, idleMs: number): T {
  if (!socket) return socket;
  const tcp = socket as unknown as Socket;
  const arm = tcp.setTimeout.bind(tcp);
  let waitedOnReader = false;
  const onIdle = () => {
    // A reader that stopped pulling (backpressure) paused the socket; the store is not stalled.
    // Once it pulls again, the store gets a full period before silence counts, so a stall is
    // caught within twice the limit.
    if (tcp.isPaused() || waitedOnReader) {
      waitedOnReader = tcp.isPaused();
      arm(idleMs);
      return;
    }
    tcp.destroy(
      Object.assign(new Error(`Object storage sent nothing for ${idleMs} ms`), {
        code: "ETIMEDOUT",
      }),
    );
  };
  arm(idleMs);
  tcp.setTimeout = () => tcp;
  const emit = tcp.emit.bind(tcp);
  tcp.emit = ((event: string | symbol, ...args: unknown[]) => {
    if (event !== "timeout") return emit(event, ...args);
    onIdle();
    return true;
  }) as typeof tcp.emit;
  return socket;
}

/**
 * Connection options for the S3 client. The idle limit starts when a socket exists, so a request
 * waiting for one of the pooled sockets is never failed for the wait, and it also bounds connecting.
 */
export function objectStorageRequestHandler(idleMs = IDLE_SOCKET_TIMEOUT_MS) {
  const options = { keepAlive: true, maxSockets: MAX_SOCKETS };
  class IdleHttpAgent extends HttpAgent {
    override createConnection(...args: Parameters<HttpAgent["createConnection"]>) {
      return failWhenIdle(super.createConnection(...args), idleMs);
    }
  }
  class IdleHttpsAgent extends HttpsAgent {
    override createConnection(...args: Parameters<HttpsAgent["createConnection"]>) {
      return failWhenIdle(super.createConnection(...args), idleMs);
    }
  }
  return { httpAgent: new IdleHttpAgent(options), httpsAgent: new IdleHttpsAgent(options) };
}

export interface S3ObjectStorageConfig {
  bucket: string;
  /** Service URL; empty uses the SDK's default endpoint for the region. */
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Prepended to every key, so one bucket can hold several deployments. */
  prefix: string;
  /** Address the bucket in the path instead of the host name. */
  pathStyle: boolean;
}

/**
 * `OBJECT_STORAGE_BUCKET` turns object storage on; the other settings describe the connection.
 * Credentials are required rather than taken from the SDK's default chain, so object storage
 * never borrows credentials configured for something else.
 */
export function objectStorageConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): S3ObjectStorageConfig | undefined {
  const bucket = env.OBJECT_STORAGE_BUCKET?.trim();
  if (!bucket) return undefined;
  const accessKeyId = env.OBJECT_STORAGE_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.OBJECT_STORAGE_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey)
    throw new Error(
      "OBJECT_STORAGE_ACCESS_KEY_ID and OBJECT_STORAGE_SECRET_ACCESS_KEY are required with OBJECT_STORAGE_BUCKET",
    );
  const endpoint = env.OBJECT_STORAGE_ENDPOINT?.trim() || undefined;
  if (endpoint && !/^https?:\/\//.test(endpoint))
    throw new Error("OBJECT_STORAGE_ENDPOINT must be an http(s) URL");
  const pathStyle = env.OBJECT_STORAGE_PATH_STYLE?.trim().toLowerCase();
  if (pathStyle && pathStyle !== "true" && pathStyle !== "false")
    throw new Error('OBJECT_STORAGE_PATH_STYLE must be "true" or "false"');
  const prefix = (env.OBJECT_STORAGE_PREFIX?.trim() ?? "").replace(/^\/+|\/+$/g, "");
  return {
    bucket,
    endpoint,
    region: env.OBJECT_STORAGE_REGION?.trim() || "us-east-1",
    accessKeyId,
    secretAccessKey,
    prefix: prefix ? `${prefix}/` : "",
    pathStyle: pathStyle === "true",
  };
}

export class S3ObjectStorage implements ObjectStorage {
  private s3?: Promise<{ sdk: typeof S3Sdk; client: S3Sdk.S3Client }>;

  constructor(
    private readonly config: S3ObjectStorageConfig,
    private readonly client?: S3Sdk.S3Client,
  ) {}

  /** The SDK loads on first use, so deployments without object storage never load it. */
  private connect() {
    this.s3 ??= import("@aws-sdk/client-s3").then((sdk) => ({
      sdk,
      client:
        this.client ??
        new sdk.S3Client({
          region: this.config.region,
          endpoint: this.config.endpoint,
          forcePathStyle: this.config.pathStyle,
          credentials: {
            accessKeyId: this.config.accessKeyId,
            secretAccessKey: this.config.secretAccessKey,
          },
          // Checksums only where the protocol requires them; not every S3-compatible service
          // accepts the newer optional ones.
          requestChecksumCalculation: "WHEN_REQUIRED",
          responseChecksumValidation: "WHEN_REQUIRED",
          requestHandler: objectStorageRequestHandler(),
        }),
    }));
    return this.s3;
  }

  private key(key: string) {
    return `${this.config.prefix}${key}`;
  }

  async put(key: string, body: AsyncIterable<Uint8Array>): Promise<void> {
    const { sdk, client } = await this.connect();
    const Bucket = this.config.bucket;
    const Key = this.key(key);
    const source = parts(body, PART_BYTES)[Symbol.asyncIterator]();
    // Closing the source stops packing and releases any file it holds open, on every path.
    try {
      const first = await source.next();
      const second = first.done ? first : await source.next();
      if (second.done) {
        const bytes = first.done ? Buffer.alloc(0) : first.value;
        await client.send(
          new sdk.PutObjectCommand({ Bucket, Key, Body: bytes, ContentLength: bytes.length }),
        );
        return;
      }
      const { UploadId } = await client.send(new sdk.CreateMultipartUploadCommand({ Bucket, Key }));
      if (!UploadId) throw new Error("Object storage did not start a multipart upload");
      const uploaded: Array<{ ETag: string; PartNumber: number }> = [];
      const upload = async (bytes: Buffer) => {
        const PartNumber = uploaded.length + 1;
        const { ETag } = await client.send(
          new sdk.UploadPartCommand({
            Bucket,
            Key,
            UploadId,
            PartNumber,
            Body: bytes,
            ContentLength: bytes.length,
          }),
        );
        if (!ETag) throw new Error("Object storage did not acknowledge an upload part");
        uploaded.push({ ETag, PartNumber });
      };
      try {
        await upload((first as IteratorYieldResult<Buffer>).value);
        await upload(second.value);
        for (let next = await source.next(); !next.done; next = await source.next())
          await upload(next.value);
        await client.send(
          new sdk.CompleteMultipartUploadCommand({
            Bucket,
            Key,
            UploadId,
            MultipartUpload: { Parts: uploaded },
          }),
        );
      } catch (error) {
        await client
          .send(new sdk.AbortMultipartUploadCommand({ Bucket, Key, UploadId }))
          .catch(() => undefined);
        throw error;
      }
    } finally {
      await source.return?.(undefined);
    }
  }

  async *get(key: string): AsyncGenerator<Uint8Array> {
    const { sdk, client } = await this.connect();
    const { Body } = await client.send(
      new sdk.GetObjectCommand({ Bucket: this.config.bucket, Key: this.key(key) }),
    );
    if (!Body) throw new Error("Object storage returned no body");
    yield* Body as Readable;
  }

  async *list(prefix: string): AsyncGenerator<{ key: string; lastModified: Date }> {
    const { sdk, client } = await this.connect();
    let ContinuationToken: string | undefined;
    do {
      const page = await client.send(
        new sdk.ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: this.key(prefix),
          ContinuationToken,
        }),
      );
      for (const object of page.Contents ?? []) {
        if (!object.Key?.startsWith(this.config.prefix)) continue;
        yield {
          key: object.Key.slice(this.config.prefix.length),
          lastModified: object.LastModified ?? new Date(0),
        };
      }
      ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (ContinuationToken);
  }

  async delete(keys: readonly string[]): Promise<void> {
    const { sdk, client } = await this.connect();
    for (let start = 0; start < keys.length; start += DELETE_BATCH) {
      const { Errors } = await client.send(
        new sdk.DeleteObjectsCommand({
          Bucket: this.config.bucket,
          Delete: {
            Quiet: true,
            Objects: keys.slice(start, start + DELETE_BATCH).map((key) => ({ Key: this.key(key) })),
          },
        }),
      );
      if (Errors?.length)
        throw new Error(`Object storage could not delete ${Errors.length} objects`);
    }
  }
}

/** Regroups a stream into buffers of exactly `size` bytes, except a shorter last one. */
async function* parts(source: AsyncIterable<Uint8Array>, size: number): AsyncGenerator<Buffer> {
  let held: Buffer[] = [];
  let length = 0;
  for await (const chunk of source) {
    let rest = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    while (length + rest.length >= size) {
      const take = size - length;
      held.push(rest.subarray(0, take));
      yield Buffer.concat(held);
      held = [];
      length = 0;
      rest = rest.subarray(take);
    }
    if (rest.length) {
      // Copy: callers may reuse the buffers they yield.
      held.push(Buffer.from(rest));
      length += rest.length;
    }
  }
  if (length) yield Buffer.concat(held);
}
