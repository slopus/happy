'use strict';

const { createClient } = require('./client');

let nativeModule;
module.exports = createClient(() => {
  if (!nativeModule) {
    const { requireOptionalNativeModule } = require('expo-modules-core');
    nativeModule = requireOptionalNativeModule('ExpoTailcat');
    if (!nativeModule) {
      throw new Error('expo-tailcat requires a custom iOS or Android native build. Expo Go and web are not supported.');
    }
  }
  return nativeModule;
});