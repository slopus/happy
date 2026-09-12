module.exports = {
  expo: {
    name: 'Tailcat E2E',
    slug: 'expo-tailcat-e2e',
    version: '1.0.0',
    ios: {
      bundleIdentifier: 'engineering.happy.tailcat.e2e',
      // Test fixture and localhost gateway only. The published plugin does not
      // enable arbitrary cleartext traffic.
      infoPlist: { NSAppTransportSecurity: { NSAllowsArbitraryLoads: true } },
    },
    android: { package: 'engineering.happy.tailcat.e2e' },
    plugins: ['expo-tailcat'],
  },
};