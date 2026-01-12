module.exports = function (api) {
  api.cache(true);

  // Determine which worklets plugin to use based on installed versions
  // Reanimated v4+ uses react-native-worklets/plugin
  // Reanimated v3.x uses react-native-reanimated/plugin
  let workletsPlugin = 'react-native-worklets/plugin';
  try {
    const reanimatedVersion = require('react-native-reanimated/package.json').version;
    const majorVersion = parseInt(reanimatedVersion.split('.')[0], 10);

    // For Reanimated v3.x, use the old plugin
    if (majorVersion < 4) {
      workletsPlugin = 'react-native-reanimated/plugin';
    }
  } catch (e) {
    // If reanimated isn't installed, default to newer plugin
    // This won't cause issues since the plugin won't be needed anyway
  }

  return {
    presets: ['babel-preset-expo'],
    env: {
      production: {
        plugins: ["transform-remove-console"],
      },
    },
    plugins: [
      ['react-native-unistyles/plugin', { root: 'sources' }],
      workletsPlugin // Must be last - automatically selects correct plugin for version
    ],
  };
};