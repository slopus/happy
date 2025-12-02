const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Exclude test files from bundling
config.resolver = {
  ...config.resolver,
  sourceExts: [...(config.resolver?.sourceExts || [])],
  blockList: [
    /.*\.spec\.ts$/,
    /.*\.test\.ts$/,
  ]
};

module.exports = config;