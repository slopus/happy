const variant = process.env.APP_ENV || 'development';
const name = {
    development: "Happy (dev)",
    preview: "Happy (preview)",
    production: "Happy"
}[variant];
const bundleId = {
    development: "com.slopus.happy.dev",
    preview: "com.slopus.happy.preview",
    production: "com.ex3ndr.happy"
}[variant];

export default {
    expo: {
        name,
        slug: "happy",
        version: "1.0.4",
        runtimeVersion: "10",
        orientation: "portrait",
        icon: "./sources/assets/images/happy-otter-icon.png",
        scheme: "happy",
        userInterfaceStyle: "automatic",
        newArchEnabled: true,
        splash: {
            image: "./sources/assets/images/splash-icon.png",
            imageWidth: 256,
            backgroundColor: "#ffffff"
        },
        ios: {
            supportsTablet: true,
            bundleIdentifier: bundleId,
            config: {
                usesNonExemptEncryption: false
            }
        },
        android: {
            adaptiveIcon: {
                foregroundImage: "./sources/assets/images/adaptive-icon.png",
                backgroundColor: "#ffffff"
            },
            blockedPermissions: [
                "android.permission.ACTIVITY_RECOGNITION"
            ],
            edgeToEdgeEnabled: true,
            package: bundleId,
            googleServicesFile: "./google-services.json"
        },
        web: {
            bundler: "metro",
            output: "static",
            favicon: "./sources/assets/images/happy-otter-icon.png"
        },
        plugins: [
            [
                "expo-router",
                {
                    root: "./sources/app"
                }
            ],
            "expo-updates",
            "expo-asset",
            "expo-localization",
            "expo-mail-composer",
            "expo-secure-store",
            "expo-web-browser",
            "react-native-vision-camera",
            "react-native-libsodium",
            [
                "expo-location",
                {
                    locationAlwaysAndWhenInUsePermission: "Allow $(PRODUCT_NAME) to improve AI quality by using your location.",
                    locationAlwaysPermission: "Allow $(PRODUCT_NAME) to improve AI quality by using your location.",
                    locationWhenInUsePermission: "Allow $(PRODUCT_NAME) to improve AI quality by using your location."
                }
            ],
            [
                "expo-calendar",
                {
                    "calendarPermission": "Allow $(PRODUCT_NAME) to access your calendar to improve AI quality."
                }
            ]
        ],
        updates: {
            url: "https://u.expo.dev/4558dd3d-cd5a-47cd-bad9-e591a241cc06",
            requestHeaders: {
                "expo-channel-name": "production"
            }
        },
        experiments: {
            typedRoutes: true
        },
        extra: {
            router: {
                root: "./sources/app"
            },
            eas: {
                projectId: "4558dd3d-cd5a-47cd-bad9-e591a241cc06"
            }
        },
        owner: "bulkacorp"
    }
};