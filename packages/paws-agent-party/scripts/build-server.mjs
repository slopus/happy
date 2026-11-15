import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

await Promise.all([
  rm(new URL('../dist/server.mjs', import.meta.url), { force: true }),
  rm(new URL('../dist/server.mjs.map', import.meta.url), { force: true }),
]);
await build({
  entryPoints: [fileURLToPath(new URL('../src/server/index.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('../dist/server.mjs', import.meta.url)),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  ...(process.env.PAWS_AGENT_PARTY_STANDALONE === '1'
    ? { banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } }
    : { packages: 'external' }),
});
