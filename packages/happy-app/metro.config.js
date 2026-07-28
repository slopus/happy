const { getDefaultConfig } = require("expo/metro-config");
const fs = require("fs");
const path = require("path");

const config = getDefaultConfig(__dirname, {
  // Enable CSS support for web
  isCSSEnabled: true,
});

// Metro's global transform cache otherwise lets concurrently running sibling
// worktrees reuse an expo-router context compiled for a different checkout.
config.cacheVersion = `happy-app:${__dirname}`;

// Sibling worktrees reuse the main checkout's root node_modules through a
// symlink. Metro does not reliably follow that symlink during hierarchical
// lookup, so include its resolved ARM-native dependency directory explicitly.
const workspaceNodeModules = path.resolve(__dirname, "../../node_modules");
const monorepoRoot = path.resolve(__dirname, "../..");
const resolvedWorkspaceNodeModules = fs.realpathSync(workspaceNodeModules);
const sharedAppNodeModules = path.join(
  path.dirname(resolvedWorkspaceNodeModules),
  "packages/happy-app/node_modules"
);
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, "node_modules"),
  sharedAppNodeModules,
  resolvedWorkspaceNodeModules,
];
config.watchFolders = Array.from(new Set([
  ...(config.watchFolders || []),
  monorepoRoot,
]));
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  "@slopus/happy-wire": path.join(monorepoRoot, "packages/happy-wire"),
};

// Add support for .wasm files (required by Skia for all platforms)
// Source: https://shopify.github.io/react-native-skia/docs/getting-started/installation/
config.resolver.assetExts.push('wasm');

// Exclude Tauri Rust build artifacts from Metro's file watcher.
// Cargo writes/deletes transient files in src-tauri/target/debug/deps during
// `tauri dev`, which crashes Metro's fallback watcher on Windows with ENOENT.
//
// Also exclude any stray `node_modules/electron` install. It's not a real
// dependency of this app, but a transitive/optional install can drop it into
// the root node_modules. Metro's TreeFS then crawls electron's
// `Electron Framework.framework/Libraries` symlink and crashes with
// "already exists in the file map as a file", aborting `expo export` / OTA.
config.resolver.blockList = [
  /[/\\]src-tauri[/\\]target[/\\].*/,
  /[/\\]node_modules[/\\]electron[/\\].*/,
];

// Force every preact / preact/hooks import (ESM or CJS, from any package) to
// resolve to a SINGLE file. preact's package.json exports field maps "import"
// to preact.mjs and "require" to preact.js, which makes Metro register two
// separate module instances depending on the importer's module type. Two
// instances mean two `options` objects — preact/hooks patches one,
// @pierre/trees renders against the other, currentComponent stays undefined,
// `r.__H` crashes. Pin to the CJS bundles so everyone shares state.
const preactCjsPath = require.resolve('preact');
const preactHooksCjsPath = require.resolve('preact/hooks');
const baseResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'preact') {
    return { filePath: preactCjsPath, type: 'sourceFile' };
  }
  if (moduleName === 'preact/hooks') {
    return { filePath: preactHooksCjsPath, type: 'sourceFile' };
  }
  if (baseResolveRequest) {
    return baseResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

// Enable inlineRequires for proper Skia and Reanimated loading
// Source: https://shopify.github.io/react-native-skia/docs/getting-started/web/
// Without this, Skia throws "react-native-reanimated is not installed" error
// This is cross-platform compatible (iOS, Android, web)
config.transformer.getTransformOptions = async () => ({
  transform: {
    experimentalImportSupport: false,
    inlineRequires: true, // Critical for @shopify/react-native-skia
  },
});

module.exports = config;
