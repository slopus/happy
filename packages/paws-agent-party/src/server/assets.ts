import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import type { ImageRef } from '../contracts.js';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_BODY_BYTES = 11 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 4;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export type AssetMetadataWriter = (
  directory: string,
  metadata: Readonly<Record<string, ImageRef>>,
) => Promise<void>;

export class AssetStore {
  readonly directory: string;
  private metadata: Record<string, ImageRef> | null = null;
  private loadPromise: Promise<void> | null = null;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(dataDir: string, private readonly metadataWriter: AssetMetadataWriter = writeMetadata) {
    this.directory = join(dataDir, 'assets');
  }

  async put(input: { name: string; mimeType: string; bytes: Uint8Array }): Promise<ImageRef> {
    validateImage(input.mimeType, input.bytes.byteLength);
    await this.ensureLoaded();
    const id = randomUUID();
    const name = safeName(input.name);
    const ref: ImageRef = { id, name, mimeType: input.mimeType, size: input.bytes.byteLength };
    await writeFile(join(this.directory, id), input.bytes, { flag: 'wx', mode: 0o600 });
    this.metadata![id] = ref;
    await this.persist();
    return ref;
  }

  async resolve(ref: ImageRef): Promise<{ ref: ImageRef; bytes: Uint8Array }> {
    await this.ensureLoaded();
    const stored = this.metadata![ref.id];
    if (!stored) throw new AssetError(404, 'Unknown image asset.');
    if (
      stored.name !== ref.name
      || stored.mimeType !== ref.mimeType
      || stored.size !== ref.size
    ) throw new AssetError(400, 'Image reference does not match stored metadata.');
    return { ref: stored, bytes: await this.read(stored.id) };
  }

  async read(id: string): Promise<Uint8Array> {
    await this.ensureLoaded();
    if (!this.metadata![id]) throw new AssetError(404, 'Unknown image asset.');
    return readFile(join(this.directory, id));
  }

  async get(id: string): Promise<ImageRef | null> {
    await this.ensureLoaded();
    return this.metadata![id] ?? null;
  }

  async list(): Promise<ImageRef[]> {
    await this.ensureLoaded();
    return Object.values(this.metadata!);
  }

  async resolveMany(refs: ImageRef[]): Promise<Array<{ ref: ImageRef; bytes: Uint8Array }>> {
    if (refs.length > MAX_IMAGES_PER_MESSAGE) {
      throw new AssetError(400, `At most ${MAX_IMAGES_PER_MESSAGE} images are allowed.`);
    }
    return Promise.all(refs.map(ref => this.resolve(ref)));
  }

  private async ensureLoaded(): Promise<void> {
    if (this.metadata) return;
    if (!this.loadPromise) this.loadPromise = this.load();
    await this.loadPromise;
  }

  private async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    try {
      const parsed = JSON.parse(await readFile(join(this.directory, 'metadata.json'), 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid asset metadata');
      this.metadata = parsed as Record<string, ImageRef>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.metadata = {};
    }
  }

  private persist(): Promise<void> {
    const snapshot = structuredClone(this.metadata!);
    const pending = this.persistQueue.then(() => this.metadataWriter(this.directory, snapshot));
    this.persistQueue = pending.catch(() => undefined);
    return pending;
  }
}

async function writeMetadata(directory: string, metadata: Readonly<Record<string, ImageRef>>): Promise<void> {
  const target = join(directory, 'metadata.json');
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(metadata), { flag: 'wx', mode: 0o600 });
  await rename(temporary, target);
  await chmod(target, 0o600);
}

export class AssetError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'AssetError';
  }
}

function validateImage(mimeType: string, size: number): void {
  if (!IMAGE_TYPES.has(mimeType)) throw new AssetError(415, 'Only PNG, JPEG, or WebP images are accepted.');
  if (size > MAX_IMAGE_BYTES) throw new AssetError(413, 'Each image must be at most 10 MiB.');
  if (size < 1) throw new AssetError(400, 'Image cannot be empty.');
}

function safeName(name: string): string {
  let decoded = name;
  try { decoded = decodeURIComponent(name); } catch { throw new AssetError(400, 'Invalid encoded filename.'); }
  const value = basename(decoded).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!value || value.length > 255) throw new AssetError(400, 'Invalid image filename.');
  return value;
}
