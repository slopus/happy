const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");
const path = require("path");

const config = getDefaultConfig(__dirname);

// Define paths
const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../");

const liberalShared = path.resolve(monorepoRoot, "liberal");

const ourModules = path.resolve(projectRoot, "node_modules");

// Set up watch folders - Metro needs to watch all workspace directories
config.watchFolders = [projectRoot, liberalShared];

// Configure module resolution - tell Metro where to find node_modules
config.resolver.nodeModulesPaths = [liberalShared, ourModules];

module.exports = withNativeWind(config, {
  input: path.join(__dirname, "sources/global.css"),
});
