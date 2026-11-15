import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import type {
  AdapterContext,
  ArtifactPut,
  ArtifactStore,
  ObjectStorage,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  ContentDecryptionError,
  contentEncryptionOf,
  openArtifact,
  sealArtifact,
} from "@rakazo/db";
import type { ArtifactKeys } from "./artifacts.js";
import { LocalArtifactStore } from "./artifacts.js";
import { objectStorageConfigFromEnv, S3ObjectStorage } from "./s3-object-storage.js";

const OBJECT_ID = /^object:([0-9a-f-]{36})$/;

/** Object contents are always sealed, even when plaintext database writes are enabled. */
export class ObjectArtifactStore implements ArtifactStore {
  constructor(
    private readonly storage: ObjectStorage,
    private readonly keys: ArtifactKeys,
  ) {}

  describe() {
    return {
      id: "object-artifacts",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { stream: true },
    };
  }

  private key(id: string, spaceId: string) {
    const match = OBJECT_ID.exec(id);
    if (!match || !spaceId || spaceId.includes("/") || spaceId.includes("\\"))
      throw new Error("Invalid artifact storage key");
    return `artifacts/${spaceId}/${match[1]}`;
  }

  async put(artifact: ArtifactPut, context: AdapterContext) {
    context.signal.throwIfAborted();
    const id = `object:${randomUUID()}`;
    const key = await this.keys.current(context.spaceId);
    await this.storage.put(
      this.key(id, context.spaceId),
      sealArtifact(key, id, Readable.from([artifact.bytes])),
    );
    return { id, hash: String(artifact.bytes.byteLength) };
  }

  async get(id: string, context: AdapterContext) {
    context.signal.throwIfAborted();
    const bytes = await buffer(
      openArtifact(
        async (keyId) => {
          const key = await this.keys.byId(keyId);
          if (key.spaceId !== context.spaceId)
            throw new ContentDecryptionError("Encrypted artifact belongs to another space");
          return key;
        },
        id,
        this.storage.get(this.key(id, context.spaceId)),
      ),
    );
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  async remove(id: string, context: AdapterContext) {
    await this.storage.delete([this.key(id, context.spaceId)]);
  }
}

/** Explicit storage keys preserve access to pre-existing local files during migration. */
export class DeploymentArtifactStore implements ArtifactStore {
  constructor(
    private readonly local: ArtifactStore,
    private readonly object?: ArtifactStore,
  ) {}
  describe() {
    return (this.object ?? this.local).describe();
  }
  put(artifact: ArtifactPut, context: AdapterContext) {
    return (this.object ?? this.local).put(artifact, context);
  }
  private forId(id: string): ArtifactStore {
    if (!id.startsWith("object:")) return this.local;
    if (!this.object) throw new Error("This artifact requires the configured object storage");
    return this.object;
  }
  async get(id: string, context: AdapterContext) {
    return this.forId(id).get(id, context);
  }
  async remove(id: string, context: AdapterContext) {
    return this.forId(id).remove(id, context);
  }
}

export function createArtifactStore(
  dataDir: string,
  prisma: PrismaClient,
  env: NodeJS.ProcessEnv = process.env,
): ArtifactStore {
  const keys = contentEncryptionOf(prisma)?.ring;
  const local = new LocalArtifactStore(dataDir, keys);
  const config = objectStorageConfigFromEnv(env);
  if (!config) return new DeploymentArtifactStore(local);
  if (!keys) throw new Error("Storing artifacts in object storage needs content encryption keys");
  return new DeploymentArtifactStore(
    local,
    new ObjectArtifactStore(new S3ObjectStorage(config), keys),
  );
}
