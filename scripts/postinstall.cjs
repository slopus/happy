const { execSync } = require('child_process');

// Apply patches to node_modules
require('../patches/fix-pglite-prisma-bytes.cjs');

const wireWorkspaceName = require('../packages/huppy-wire/package.json').name;

if (process.env.SKIP_HAPPY_WIRE_BUILD === '1') {
  console.log(`[postinstall] SKIP_HAPPY_WIRE_BUILD=1, skipping ${wireWorkspaceName} build`);
  process.exit(0);
}

execSync(`yarn workspace ${wireWorkspaceName} build`, {
  stdio: 'inherit',
});
