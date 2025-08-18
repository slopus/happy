module.exports = function (api) {
  api.cache(true);
  return {
    presets: [['babel-preset-expo', { jsxImportSource: 'nativewind' }], 'nativewind/babel'],
    env: {
      production: {
        plugins: ["transform-remove-console"],
      },
    },
    plugins: [
      'react-native-worklets/plugin',
      ['react-native-unistyles/plugin', { root: 'sources' }]
    ],
  };
};