const { withAppBuildGradle } = require('@expo/config-plugins');

const withAndroidSigning = (config, options = {}) => {
  return withAppBuildGradle(config, (config) => {
    const contents = config.modResults.contents;
    
    if (contents.includes('MYAPP_UPLOAD_STORE_FILE')) {
      return config;
    }
    
    const signingConfig = `
    release {
        if (project.hasProperty('MYAPP_UPLOAD_STORE_FILE')) {
            storeFile file(MYAPP_UPLOAD_STORE_FILE)
            storePassword MYAPP_UPLOAD_STORE_PASSWORD
            keyAlias MYAPP_UPLOAD_KEY_ALIAS
            keyPassword MYAPP_UPLOAD_KEY_PASSWORD
        }
    }
`;
    
    const signingConfigsMatch = contents.match(/signingConfigs\s*\{[\s\S]*?debug\s*\{[\s\S]*?\}/);
    if (signingConfigsMatch) {
      const updatedContents = contents.replace(
        /(signingConfigs\s*\{[\s\S]*?debug\s*\{[\s\S]*?\})/,
        `$1${signingConfig}`
      );
      config.modResults.contents = updatedContents;
    }
    
    const buildTypesMatch = config.modResults.contents.match(/buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?\}/);
    if (buildTypesMatch && !config.modResults.contents.includes('signingConfig signingConfigs.release')) {
      config.modResults.contents = config.modResults.contents.replace(
        /(buildTypes\s*\{[\s\S]*?release\s*\{)/,
        `$1\n            signingConfig signingConfigs.release`
      );
    }
    
    return config;
  });
};

module.exports = withAndroidSigning;
