const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname, {
  // Enable CSS support for web
  isCSSEnabled: true,
});

// Add support for .wasm files (required by Skia for all platforms)
// Source: https://shopify.github.io/react-native-skia/docs/getting-started/installation/
config.resolver.assetExts.push('wasm');

// Fix libsodium-wrappers for web builds
// The ESM version (added in 0.7.16) uses top-level await which Metro doesn't support
// Force the CommonJS version for web platform
//
// NOTE: Upstream Happy pins to 0.7.14 which doesn't have ESM build, avoiding this issue.
// See: https://github.com/slopus/happy/blob/main/yarn.lock
// Our yarn.lock resolved to 0.7.16 which introduced the ESM build with top-level await.
// TODO: Revisit if libsodium-wrappers fixes ESM compatibility or if we should pin version.
const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Force libsodium packages to use CommonJS on web
  if (platform === "web") {
    if (moduleName === "libsodium-wrappers") {
      return {
        type: "sourceFile",
        filePath: path.resolve(__dirname, "../node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js"),
      };
    }
    if (moduleName === "libsodium") {
      return {
        type: "sourceFile",
        filePath: path.resolve(__dirname, "../node_modules/libsodium/dist/modules/libsodium.js"),
      };
    }
  }
  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform);
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
