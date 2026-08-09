const { execFileSync } = require('node:child_process');
const { OTA_RUNTIME_VERSION_BY_VARIANT } = require('./scripts/ota-runtime-config.js');

const variant = process.env.APP_ENV || 'development';
const name = {
    development: "Paws (dev)",
    preview: "Paws (preview)",
    production: "Paws"
}[variant];
const bundleId = {
    development: "build.paws.dev",
    preview: "build.paws.preview",
    production: "build.paws"
}[variant];
// const stagingElevenLabsAgentId = 'agent_7801k2c0r5hjfraa1kdbytpvs6yt';
const productionElevenLabsAgentId = 'agent_6701k211syvvegba4kt7m68nxjmw';
const elevenLabsAgentId = {
    development: productionElevenLabsAgentId,
    preview: productionElevenLabsAgentId,
    production: productionElevenLabsAgentId,
}[variant];
const consoleLoggingDefault = {
    development: true,
    preview: true,
    production: false,
}[variant];
// 自建 OTA 频道：开发/预览包都拉 preview 频道（供开发在真机预览 PR），
// 正式包拉 production 频道。两条频道互不干扰，预览发布不会影响线上用户。
// 注意：频道在构建时写死进包，改了必须重新构建装机才生效。
const otaChannel = {
    development: "preview",
    preview: "preview",
    production: "production",
}[variant];
const otaRuntimeVersion = OTA_RUNTIME_VERSION_BY_VARIANT[variant];
const localHttpException = {
    NSExceptionAllowsInsecureHTTPLoads: true,
    NSTemporaryExceptionAllowsInsecureHTTPLoads: true,
    NSIncludesSubdomains: true,
};
const developmentAppTransportSecurity = {
    NSAllowsLocalNetworking: true,
    NSAllowsArbitraryLoads: true,
    NSAllowsArbitraryLoadsInWebContent: true,
    NSAllowsArbitraryLoadsForMedia: true,
    NSExceptionDomains: {
        localhost: localHttpException,
        "127.0.0.1": localHttpException,
        "198.18.0.1": localHttpException,
    },
};

function git(args) {
    try {
        return execFileSync('git', args, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() || undefined;
    } catch {
        return undefined;
    }
}

function loadBuildMetadata() {
    const commitSha =
        process.env.HAPPY_BUILD_COMMIT_SHA ||
        process.env.EAS_BUILD_GIT_COMMIT_HASH ||
        process.env.GITHUB_SHA ||
        git(['rev-parse', 'HEAD']);
    const commitTimestamp =
        process.env.HAPPY_BUILD_COMMIT_TIMESTAMP ||
        (commitSha
            ? git(['show', '-s', '--format=%cI', commitSha])
            : git(['show', '-s', '--format=%cI', 'HEAD']));

    return {
        commitSha,
        commitTimestamp,
    };
}

const buildMetadata = loadBuildMetadata();

export default {
    expo: {
        name,
        slug: "paws",
        version: "1.7.1",
        runtimeVersion: otaRuntimeVersion,
        orientation: "default",
        icon: "./sources/assets/images/icon.png",
        scheme: "paws",
        userInterfaceStyle: "automatic",
        ios: {
            supportsTablet: true,
            bundleIdentifier: bundleId,
            config: {
                usesNonExemptEncryption: false
            },
            infoPlist: {
                NSMicrophoneUsageDescription: "Allow $(PRODUCT_NAME) to access your microphone for voice conversations with AI.",
                NSLocalNetworkUsageDescription: "Allow $(PRODUCT_NAME) to find and connect to local devices on your network.",
                NSBonjourServices: ["_http._tcp", "_https._tcp"],
                // ATS:
                // - NSAllowsLocalNetworking: lets HTTP fetches reach LAN
                //   addresses (e.g. self-hosted server at 192.168.x.y) without
                //   forcing TLS. Production cloud server is HTTPS, so the
                //   default policy still applies there.
                // - In dev/preview, explicitly allow local HTTP endpoints used
                //   by Expo Dev Launcher and iOS Simulator. Some loader paths
                //   enforce ATS before the broader arbitrary-load switch is
                //   honored, so keep domain-level exceptions for local hosts.
                NSAppTransportSecurity: variant === 'production'
                    ? { NSAllowsLocalNetworking: true }
                    : developmentAppTransportSecurity
            },
            // Universal Links 需真实域名 + AASA 文件，IP 自托管暂不支持；有域名后填 ["applinks:<your-domain>"]
            associatedDomains: []
        },
        android: {
            adaptiveIcon: {
                foregroundImage: "./sources/assets/images/icon-adaptive.png",
                monochromeImage: "./sources/assets/images/icon-monochrome.png",
                backgroundColor: "#18171C"
            },
            permissions: [
                "android.permission.RECORD_AUDIO",
                "android.permission.MODIFY_AUDIO_SETTINGS",
                "android.permission.ACCESS_NETWORK_STATE",
                "android.permission.POST_NOTIFICATIONS",
            ],
            blockedPermissions: [
                "android.permission.ACTIVITY_RECOGNITION",
                // Not using external storage/media access for now — blocks Google Play photo/video permission declaration
                "android.permission.READ_EXTERNAL_STORAGE",
                "android.permission.WRITE_EXTERNAL_STORAGE",
                "android.permission.READ_MEDIA_IMAGES",
                "android.permission.READ_MEDIA_VIDEO",
                "android.permission.READ_MEDIA_VISUAL_USER_SELECTED",
            ],
            package: bundleId,
            googleServicesFile: "./google-services.json",
            // Android App Links 需真实域名 + assetlinks.json，IP 自托管暂不支持；有域名后恢复 https intentFilter
            intentFilters: []
        },
        web: {
            bundler: "metro",
            output: "single",
            favicon: "./sources/assets/images/favicon.png"
        },
        plugins: [
            require("./plugins/withEinkCompatibility.js"),
            require("./plugins/withCleartextTraffic.js"),
            require("./plugins/withSelfHostedServerTrust.js"),
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
            [
                "expo-media-library",
                {
                    photosPermission: false,
                    savePhotosPermission: "Allow $(PRODUCT_NAME) to save generated images to your photo library.",
                    granularPermissions: []
                }
            ],
            "expo-secure-store",
            "expo-web-browser",
            "react-native-vision-camera",
            "@more-tech/react-native-libsodium",
            "react-native-audio-api",
            "@livekit/react-native-expo-plugin",
            "@config-plugins/react-native-webrtc",
            [
                "expo-audio",
                {
                    microphonePermission: "Allow $(PRODUCT_NAME) to access your microphone for voice conversations."
                }
            ],
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
            ],
            [
                "expo-camera",
                {
                    cameraPermission: "Allow $(PRODUCT_NAME) to access your camera to scan QR codes and share photos with AI.",
                    microphonePermission: "Allow $(PRODUCT_NAME) to access your microphone for voice conversations.",
                    recordAudioAndroid: true
                }
            ],
            [
                "expo-notifications",
                {
                    "enableBackgroundRemoteNotifications": true,
                    "icon": "./sources/assets/images/icon-notification.png"
                }
            ],
            [
                'expo-splash-screen',
                {
                    ios: {
                        backgroundColor: "#F2F2F7",
                        dark: {
                            backgroundColor: "#1C1C1E",
                        }
                    },
                    android: {
                        image: "./sources/assets/images/splash-android-light.png",
                        backgroundColor: "#F5F5F5",
                        dark: {
                            image: "./sources/assets/images/splash-android-dark.png",
                            backgroundColor: "#1e1e1e",
                        }
                    }
                }
            ]
        ],
        updates: {
            // 自建 OTA：指向阿里云 FC（happy-ota-server），替换官方 u.expo.dev。
            // 改了这个地址必须重新构建装机才生效。
            url: "https://happy-oa-server-vqzpvgrhgx.cn-hangzhou.fcapp.run",
            requestHeaders: {
                "expo-channel-name": otaChannel
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
            },
            app: {
                postHogKey: process.env.EXPO_PUBLIC_POSTHOG_API_KEY,
                revenueCatAppleKey: process.env.EXPO_PUBLIC_REVENUE_CAT_APPLE,
                revenueCatGoogleKey: process.env.EXPO_PUBLIC_REVENUE_CAT_GOOGLE,
                revenueCatStripeKey: process.env.EXPO_PUBLIC_REVENUE_CAT_STRIPE,
                elevenLabsAgentId,
                consoleLoggingDefault,
                otaChannel,
                repositoryUrl: process.env.EXPO_PUBLIC_REPOSITORY_URL || 'https://github.com/wangjs-jacky/happy',
                repositoryIssuesUrl: process.env.EXPO_PUBLIC_REPOSITORY_ISSUES_URL || 'https://github.com/wangjs-jacky/happy/issues',
                buildCommitSha: buildMetadata.commitSha,
                buildCommitTimestamp: buildMetadata.commitTimestamp,
            }
        },
        owner: "bulkacorp"
    }
};
