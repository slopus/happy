'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const require_ = createRequire(__filename);

function packageRoot() {
  return __dirname;
}

function getWebappDirectory() {
  return path.join(packageRoot(), 'webapp');
}

function findTsxCli() {
  return require_.resolve('tsx/cli', { paths: [packageRoot()] });
}

function resolveServerArtifact() {
  const runtime = path.join(packageRoot(), 'dist', 'standalone.mjs');
  if (fs.existsSync(runtime)) {
    const webappDir = getWebappDirectory();
    return {
      command: process.execPath,
      prefixArgs: [runtime],
      cwd: packageRoot(),
      bundled: false,
      source: 'package',
      platform: `${process.arch}-${process.platform}`,
      webappDir: fs.existsSync(path.join(webappDir, 'index.html')) ? webappDir : undefined,
    };
  }

  const standalone = path.join(packageRoot(), 'sources', 'standalone.ts');
  if (!fs.existsSync(standalone)) return undefined;

  const webappDir = getWebappDirectory();
  return {
    command: process.execPath,
    prefixArgs: [findTsxCli(), standalone],
    cwd: packageRoot(),
    bundled: false,
    source: 'package',
    platform: `${process.arch}-${process.platform}`,
    webappDir: fs.existsSync(path.join(webappDir, 'index.html')) ? webappDir : undefined,
  };
}

module.exports = {
  packageRoot,
  getWebappDirectory,
  resolveServerArtifact,
};
