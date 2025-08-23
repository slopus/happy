const { withAndroidManifest } = require('@expo/config-plugins');

/**
 * Android hardware feature names that can be marked as optional
 */
const OPTIONAL_HARDWARE_FEATURES = [
  // Display features - important for e-ink devices that may not support touch
  'android.hardware.touchscreen',
  'android.hardware.touchscreen.multitouch',
  'android.hardware.touchscreen.multitouch.distinct',
  'android.hardware.faketouch',
  'android.hardware.screen.portrait',
  'android.hardware.screen.landscape',
  
  // Camera features (app uses camera for QR codes but should work without)
  'android.hardware.camera',
  'android.hardware.camera.autofocus',
  'android.hardware.camera.front',
  'android.hardware.camera.flash',
  'android.hardware.camera.any',
  
  // Communication features - not all e-ink devices have these
  'android.hardware.bluetooth',
  'android.hardware.bluetooth_le',
  'android.hardware.telephony',
  'android.hardware.telephony.gsm',
  'android.hardware.telephony.cdma',
  'android.hardware.wifi',
  'android.hardware.wifi.direct',
  
  // Location features - many e-ink readers don't have GPS
  'android.hardware.location',
  'android.hardware.location.gps',
  'android.hardware.location.network',
  
  // Sensors - e-ink devices often lack these sensors
  'android.hardware.sensor.accelerometer',
  'android.hardware.sensor.barometer',
  'android.hardware.sensor.compass',
  'android.hardware.sensor.gyroscope',
  'android.hardware.sensor.light',
  'android.hardware.sensor.proximity',
  'android.hardware.sensor.stepcounter',
  'android.hardware.sensor.stepdetector',
  
  // Audio - some e-ink devices don't have speakers/microphones
  'android.hardware.microphone',
  'android.hardware.audio.output',
  'android.hardware.audio.low_latency',
  'android.hardware.audio.pro',
  
  // Other hardware features
  'android.hardware.nfc',
  'android.hardware.usb.host',
  'android.hardware.usb.accessory',
  'android.hardware.vulkan.level',
  'android.hardware.vulkan.compute',
  'android.hardware.vulkan.version',
  'android.hardware.opengles.aep',
  'android.hardware.gamepad',
  'android.hardware.type.watch',
  'android.hardware.type.television',
  'android.hardware.type.automotive',
  'android.hardware.ram.low',
  'android.hardware.ram.normal',
];

/**
 * Input configuration attributes for flexible input methods
 */
const INPUT_CONFIGURATION_ATTRIBUTES = [
  'android:reqFiveWayNav',
  'android:reqHardKeyboard',
  'android:reqKeyboardType',
  'android:reqNavigation',
  'android:reqTouchScreen',
];


/**
 * Config plugin to make the app compatible with e-ink readers and other devices
 * by marking hardware features as optional instead of required.
 * 
 * This prevents Google Play Store from filtering out the app on devices
 * that don't have certain hardware features like cameras, touchscreens, etc.
 */
const withEinkCompatibility = (
  config,
  options = {}
) => {
  const { additionalFeatures = [], verbose = true } = options;
  
  return withAndroidManifest(config, (manifestConfig) => {
    const manifest = manifestConfig.modResults.manifest;
    
    // Ensure uses-feature array exists
    if (!manifest['uses-feature']) {
      manifest['uses-feature'] = [];
    }
    
    // Combine default features with any additional features
    const allFeatures = [...OPTIONAL_HARDWARE_FEATURES, ...additionalFeatures];
    
    // Add each feature with required="false"
    let addedCount = 0;
    allFeatures.forEach((featureName) => {
      // Check if feature already exists to avoid duplicates
      const existingFeature = manifest['uses-feature']?.find(
        (f) => f.$?.['android:name'] === featureName
      );
      
      if (!existingFeature) {
        const newFeature = {
          $: {
            'android:name': featureName,
            'android:required': 'false',
          },
        };
        manifest['uses-feature'].push(newFeature);
        addedCount++;
      } else if (existingFeature.$?.['android:required'] !== 'false') {
        // Update existing feature to not be required
        existingFeature.$['android:required'] = 'false';
      }
    });
    
    // Add support for all screen sizes and densities
    // This is important for e-ink devices which may have different screen characteristics
    if (!manifest['supports-screens']) {
      manifest['supports-screens'] = [];
    }
    
    // Clear existing supports-screens and add comprehensive support
    const screenSupport = {
      $: {
        'android:smallScreens': 'true',
        'android:normalScreens': 'true',
        'android:largeScreens': 'true',
        'android:xlargeScreens': 'true',
        'android:anyDensity': 'true',
        'android:resizeable': 'true',
      },
    };
    manifest['supports-screens'] = [screenSupport];
    
    // Add uses-configuration for different input methods
    // This helps with e-ink devices that may use different input methods
    if (!manifest['uses-configuration']) {
      manifest['uses-configuration'] = [];
    }
    
    // Support for devices without touch screens (navigation keys, trackball, etc.)
    let configCount = 0;
    INPUT_CONFIGURATION_ATTRIBUTES.forEach((configAttr) => {
      const exists = manifest['uses-configuration']?.find(
        (c) => c.$?.[configAttr] !== undefined
      );
      
      if (!exists) {
        const newConfig = {
          $: {
            [configAttr]: 'undefined',
          },
        };
        manifest['uses-configuration'].push(newConfig);
        configCount++;
      }
    });
    
    // Log plugin activity if verbose mode is enabled
    if (verbose) {
      console.log('✅ E-ink compatibility plugin applied successfully');
      console.log(`   Added ${addedCount} optional hardware features`);
      console.log('   Added comprehensive screen size support');
      console.log(`   Added ${configCount} flexible input method configurations`);
    }
    
    return manifestConfig;
  });
};

module.exports = withEinkCompatibility;