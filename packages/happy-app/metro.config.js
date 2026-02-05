const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");
const fs = require("fs");

const config = getDefaultConfig(__dirname, {
  // Enable CSS support for web
  isCSSEnabled: true,
});

// Add support for .wasm files (required by Skia for all platforms)
// Source: https://shopify.github.io/react-native-skia/docs/getting-started/installation/
config.resolver.assetExts.push('wasm');

// Force libsodium-wrappers to use CJS version instead of ESM
// The ESM version requires top-level await and ./libsodium.mjs which Metro can't resolve
// Try local node_modules first (Docker), then parent (monorepo development)
const libsodiumPaths = [
  path.resolve(__dirname, 'node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js'),
  path.resolve(__dirname, '../node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js'),
];
const libsodiumPath = libsodiumPaths.find(p => fs.existsSync(p));

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'libsodium-wrappers' && libsodiumPath) {
    return {
      filePath: libsodiumPath,
      type: 'sourceFile',
    };
  }
  // Fall back to default resolution
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

// Fix URL-encoded asset paths in tunnel mode
// When using ngrok tunnel, asset paths like /assets/./sources/... get encoded as
// /assets/.%2Fsources/... which Metro can't resolve. This middleware decodes the URL.
config.server = {
  ...config.server,
  enhanceMiddleware: (middleware) => {
    return (req, res, next) => {
      // Decode URL-encoded path components (e.g., %2F -> /)
      if (req.url && req.url.includes('%')) {
        req.url = decodeURIComponent(req.url);
      }
      return middleware(req, res, next);
    };
  },
};

module.exports = config;