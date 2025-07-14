module.exports = function (api) {
  api.cache(true);
  console.error("trying to resolve nativewind")
  console.log(__dirname)
  return {
    presets: [['babel-preset-expo', { jsxImportSource: 'nativewind' }], 'nativewind/babel'],
  };
};