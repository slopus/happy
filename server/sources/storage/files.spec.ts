import { describe, expect, it, vi } from 'vitest';

describe('storage/files (S3 env parsing)', () => {
  it('throws when S3_PORT is set but not a valid integer port', async () => {
    vi.resetModules();
    const { initFilesS3FromEnv } = await import('./files');

    expect(() =>
      initFilesS3FromEnv({
        S3_HOST: 'example.com',
        S3_PORT: 'nope',
        S3_BUCKET: 'bucket',
        S3_PUBLIC_URL: 'https://cdn.example.com',
        S3_ACCESS_KEY: 'access',
        S3_SECRET_KEY: 'secret',
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/S3_PORT/i);
  });

  it('throws when the configured bucket does not exist', async () => {
    vi.resetModules();
    const bucketExists = vi.fn().mockResolvedValue(false);

    vi.doMock('minio', () => {
      return {
        Client: vi.fn().mockImplementation(() => ({
          bucketExists,
          putObject: vi.fn(),
        })),
      };
    });

    const { initFilesS3FromEnv, loadFiles } = await import('./files');

    initFilesS3FromEnv({
      S3_HOST: 'example.com',
      S3_BUCKET: 'bucket',
      S3_PUBLIC_URL: 'https://cdn.example.com',
      S3_ACCESS_KEY: 'access',
      S3_SECRET_KEY: 'secret',
    } as unknown as NodeJS.ProcessEnv);

    await expect(loadFiles()).rejects.toThrow(/bucket/i);
  });
});

