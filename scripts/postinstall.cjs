const { execSync } = require('child_process');

// Apply patches to node_modules
require('../patches/fix-pglite-prisma-bytes.cjs');

if (process.env.SKIP_HAPPY_SYNC_BUILD === '1') {
  console.log('[postinstall] SKIP_HAPPY_SYNC_BUILD=1, skipping @slopus/happy-sync build');
  process.exit(0);
}

execSync('yarn workspace @slopus/happy-sync build', {
  stdio: 'inherit',
});
