const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

if (process.env.SKIP_HAPPY_WIRE_BUILD === '1') {
  console.log('[postinstall] SKIP_HAPPY_WIRE_BUILD=1, skipping @slopus/happy-wire build');
  process.exit(0);
}

// Find workspace root by walking up directory tree to find package.json with workspaces field
function findWorkspaceRoot() {
  let current = process.cwd();
  console.log('[postinstall] Starting from:', current);

  while (current !== path.dirname(current)) {
    const pkgPath = path.join(current, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.workspaces) {
          console.log('[postinstall] Found workspace root at:', current);
          return current;
        }
      } catch (e) {
        // Invalid package.json, continue searching
      }
    }
    current = path.dirname(current);
  }

  throw new Error('[postinstall] Could not find workspace root with package.json workspaces field');
}

const workspaceRoot = findWorkspaceRoot();
console.log('[postinstall] Building @slopus/happy-wire from workspace root:', workspaceRoot);

execSync('yarn workspace @slopus/happy-wire build', {
  cwd: workspaceRoot,
  stdio: 'inherit',
});
