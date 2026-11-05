const fs = require('fs');
const path = require('path');
const { withDangerousMod, withMainApplication } = require('@expo/config-plugins');

/**
 * Replaces the Android vertical ScrollView with one that accounts for view
 * transforms when it scrolls a focused descendant into view.
 *
 * Without it, tapping or long-pressing selectable text inside an inverted
 * FlashList (every row rotated 180 degrees) scrolls the chat to the far end of a
 * long message, because Android computes the text's position as if the row were
 * not rotated. TransformAwareScrollView.kt has the details.
 *
 * Two edits to the generated project:
 *   1. copy the Kotlin sources next to MainApplication's package root;
 *   2. register TransformAwareScrollPackage ahead of MainReactPackage, because
 *      React Native uses the first package that answers for "RCTScrollView".
 */
const SOURCE_DIR = path.join(__dirname, 'transformAwareScrollView');
const TARGET_PACKAGE_DIR = ['engineering', 'happy', 'scroll'];
const PACKAGE_CLASS = 'engineering.happy.scroll.TransformAwareScrollPackage';
const PACKAGE_LIST_ANCHOR = 'PackageList(this).packages.apply {';

const withTransformAwareScrollView = (config) => {
  config = withDangerousMod(config, [
    'android',
    (modConfig) => {
      const target = path.join(
        modConfig.modRequest.platformProjectRoot,
        'app', 'src', 'main', 'java',
        ...TARGET_PACKAGE_DIR,
      );
      fs.mkdirSync(target, { recursive: true });
      for (const file of fs.readdirSync(SOURCE_DIR)) {
        if (file.endsWith('.kt')) {
          fs.copyFileSync(path.join(SOURCE_DIR, file), path.join(target, file));
        }
      }
      return modConfig;
    },
  ]);

  return withMainApplication(config, (modConfig) => {
    const { contents, language } = modConfig.modResults;
    if (contents.includes(PACKAGE_CLASS)) {
      return modConfig;
    }
    // Fail the prebuild rather than ship a build that silently lacks the fix.
    if (language !== 'kt' || !contents.includes(PACKAGE_LIST_ANCHOR)) {
      throw new Error(
        `withTransformAwareScrollView: MainApplication no longer contains "${PACKAGE_LIST_ANCHOR}"; ` +
        'update the plugin to register TransformAwareScrollPackage before MainReactPackage.'
      );
    }
    modConfig.modResults.contents = contents.replace(
      PACKAGE_LIST_ANCHOR,
      `${PACKAGE_LIST_ANCHOR}\n          // First, so its ScrollView manager is used instead of MainReactPackage's.\n          add(0, ${PACKAGE_CLASS}())`,
    );
    return modConfig;
  });
};

module.exports = withTransformAwareScrollView;
