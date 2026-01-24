const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname, {
  // Enable CSS support for web
  isCSSEnabled: true,
});

// Add support for .wasm files (required by Skia for all platforms)
// Source: https://shopify.github.io/react-native-skia/docs/getting-started/installation/
config.resolver.assetExts.push('wasm');

// Force libsodium-wrappers to use CJS version instead of ESM
// The ESM version requires top-level await and ./libsodium.mjs which Metro can't resolve
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'libsodium-wrappers') {
    return {
      filePath: path.resolve(__dirname, '../node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js'),
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

module.exports = config;