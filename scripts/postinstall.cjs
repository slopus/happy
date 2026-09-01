const { execSync } = require('child_process');
const path = require('path');
const { markNodeModulesAsNoIndex } = require('./mark-node-modules-noindex.cjs');

markNodeModulesAsNoIndex({
  rootDir: path.resolve(__dirname, '..'),
});

// Apply patches to node_modules
require('../patches/fix-pglite-prisma-bytes.cjs');
require('../patches/fix-livekit-room-reuse.cjs');
require('../patches/expose-pierre-diffs-style.cjs');
require('../patches/force-preact-cjs.cjs');
require('../patches/fix-pierre-trees-preact-hooks.cjs');
require('../patches/skip-expo-notifications-web-token-listener.cjs');
require('../patches/fix-react-navigation-web-pointer-events.cjs');

if (process.env.SKIP_HAPPY_WIRE_BUILD === '1') {
  console.log('[postinstall] SKIP_HAPPY_WIRE_BUILD=1, skipping @slopus/happy-wire build');
  process.exit(0);
}

execSync('pnpm --filter @slopus/happy-wire build', {
  stdio: 'inherit',
});
