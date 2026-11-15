#!/usr/bin/env node
/**
 * Downloads the Wuying Web SDK files the Wuying screen page loads into apps/web/public/computer-screen/.
 *
 *   node scripts/wuying-web-sdk.mjs
 *
 * Only needed with SANDBOX_PROVIDER=wuying. The vendor files are not committed; this pins one
 * SDK release and refuses any file whose SHA-256 differs from the release manifest.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const VERSION = "2.13.22-asp3.18.14";
const BASE = `https://g.alicdn.com/aliyun-ecs/WuyingWebSdk-multi/${VERSION}/WuyingWebSDK/`;
const FILES = {
  "WuyingWebSDK.js": "2dfdd1b8bf0aad432ca4697a8fc04213fcbf544d741ed0d27d9815c3c4824a61",
  "sdk/ASP/container.html": "f69b03e9f8de93c5c3cce48df9399a3c8097179e0291a41520fb6dc58cb490b9",
};
const target = path.join(import.meta.dirname, "..", "apps", "web", "public", "computer-screen");

for (const [file, sha256] of Object.entries(FILES)) {
  const response = await fetch(new URL(file, BASE));
  if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(body).digest("hex");
  if (actual !== sha256) throw new Error(`${file}: checksum ${actual} does not match ${sha256}`);
  await mkdir(path.dirname(path.join(target, file)), { recursive: true });
  const content = file.endsWith(".html")
    ? body.toString("utf8").replace("<head>", '<head><script src="../../storage.js"></script>')
    : body;
  await writeFile(path.join(target, file), content);
  console.log(`${file} (${VERSION})`);
}
