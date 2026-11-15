import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** The bucket settings CI's screenshot publisher reads; the gallery lands beside its reports. */
const REQUIRED = [
  "S3_BUCKET",
  "S3_ENDPOINT",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "PLAYWRIGHT_PUBLIC_BASE_URL",
] as const;

/** Fails before a long capture when publishing cannot work. */
export function assertPublishConfigured() {
  const missing = REQUIRED.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) throw new Error(`--publish needs ${missing.join(", ")}`);
  // Signed uploads carry the access key, so they go over HTTPS only, as CI's publishers require.
  if (!process.env.S3_ENDPOINT?.startsWith("https://")) {
    throw new Error("S3_ENDPOINT must use HTTPS");
  }
}

/**
 * Uploads the gallery page and its screenshots, never logs or the manifest, which hold local
 * paths, and returns the gallery's public address.
 */
export async function publishIosGallery(outDir: string, root: string) {
  assertPublishConfigured();
  const env = process.env as Record<(typeof REQUIRED)[number], string>;
  const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root })
    .toString()
    .trim();
  const run = `${new Date().toISOString().replace(/[:.]/g, "-")}-${sha}`;
  const prefix = `playwright/ios/${run}`;
  const files = ["index.html"];
  for (const entry of await readdir(outDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    for (const shot of await readdir(path.join(outDir, entry.name))) {
      if (shot.endsWith(".png")) files.push(`${entry.name}/${shot}`);
    }
  }

  // Loaded only when publishing, so a capture never needs the storage client.
  const { PutObjectCommand, S3Client } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: process.env.AWS_DEFAULT_REGION?.trim() || "auto",
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  });
  try {
    for (const file of files) {
      await client.send(
        new PutObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: `${prefix}/${file}`,
          Body: await readFile(path.join(outDir, file)),
          ContentType: file.endsWith(".html") ? "text/html; charset=utf-8" : "image/png",
        }),
      );
    }
  } finally {
    client.destroy();
  }
  return `${env.PLAYWRIGHT_PUBLIC_BASE_URL.replace(/\/$/, "")}/ios/${run}/index.html`;
}
