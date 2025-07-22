const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");
const path = require("path");

// Get the default config from Expo
const config = getDefaultConfig(__dirname);

// Define paths
const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../");

const ourModules = path.resolve(projectRoot, "node_modules");
const allModules = path.resolve(monorepoRoot, "node_modules");
const happyLiberalModule = path.resolve(
  monorepoRoot,
  "happy-liberal/node_modules"
);

// Set up watch folders - Metro needs to watch all workspace directories
config.watchFolders = [projectRoot, happyLiberalModule, ourModules, allModules];

// Configure module resolution - tell Metro where to find node_modules
config.resolver.nodeModulesPaths = [ourModules, allModules];

// No need for custom resolveRequest - the nodeModulesPaths should handle it

module.exports = withNativeWind(config, {
  input: path.join(__dirname, "sources/global.css"),
});
