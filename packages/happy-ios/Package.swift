// swift-tools-version: 6.2

import PackageDescription

// One package serves three consumers:
//   - xtool (Linux/Windows): builds the `HappyApp` library product as the app.
//   - XcodeGen (`project.yml`): the Xcode app target compiles Sources/HappyApp
//     itself and links the `HappyKit` product.
//   - `swift build` / `swift test`: everything that does not need UIKit builds
//     and is tested on Linux and macOS. UIKit code is wrapped in
//     `#if canImport(UIKit)` and only compiles for iOS.
//
// Layout is split from drawing: `HappyLayout` imports only Foundation and
// turns sizes into frames, so every frame is tested on Linux. `HappyUI`
// measures real views and applies those frames; the tests that need UIKit to
// measure live in `HappyUIKitTests` and only run under Xcode.

let cryptoBackend: Target.Dependency = .product(
    name: "Crypto",
    package: "swift-crypto",
    // Apple platforms use CryptoKit from the SDK; swift-crypto is its
    // API-compatible implementation for Linux.
    condition: .when(platforms: [.linux])
)

let package = Package(
    name: "HappyIOS",
    defaultLocalization: "en",
    platforms: [
        .iOS(.v26),
        .macOS(.v14),
    ],
    products: [
        // The app itself. xtool expects this to be the product it packages.
        .library(name: "HappyApp", targets: ["HappyApp"]),
        // Everything the app is built from, for the XcodeGen app target.
        .library(name: "HappyKit", targets: ["HappyCrypto", "HappyWire", "HappyStore", "HappyCore", "HappyAnalytics", "HappyLayout", "HappyIcons", "HappyUI"]),
        .library(name: "HappyGuestKit", targets: ["HappyGuest", "HappyGuestUI"]),
        // Native platform shells share services/models, never UI frameworks.
        .library(name: "HappyClientKit", targets: ["HappyCrypto", "HappyWire", "HappyStore", "HappyCore", "HappyLayout", "HappyIcons"]),
    ],
    dependencies: [
        .package(url: "https://github.com/groue/GRDB.swift.git", from: "7.0.0"),
        .package(url: "https://github.com/apple/swift-crypto.git", "3.0.0"..<"5.0.0"),
        // Official WebRTC voice transport; microphone, speaker and echo
        // cancellation use the same ElevenLabs conversation JWT as happy-app.
        .package(url: "https://github.com/elevenlabs/elevenlabs-swift-sdk.git", exact: "3.4.0"),
        // Native Home and chat's optional renderer. Pin the pre-1.0 API used by
        // NodeRow and the custom keyframe scroller.
        .package(url: "https://github.com/slopus/ultraview.git", revision: "f8ddf59370296aa764100049073eecdd67909ab5"),
        .package(url: "https://github.com/slopus/tailcat-swift.git", revision: "62ffc1d7355d7b5d7adb93ceeff73498a1f287c4"),
        // The state pictures (`StateSceneView`), desktop's Lottie scenes.
        // lottie-spm is Lottie's prebuilt xcframework, so it adds no source
        // build; scenes play on its Core Animation engine, off the main
        // thread's render loop.
        .package(url: "https://github.com/airbnb/lottie-spm.git", exact: "4.5.2"),
    ],
    targets: [
        .target(name: "HappyGuest", dependencies: [cryptoBackend]),
        .target(name: "HappyGuestUI", dependencies: ["HappyGuest", "HappyLayout"]),
        .testTarget(name: "HappyGuestTests", dependencies: ["HappyGuest"]),
        .target(
            name: "HappyCrypto",
            dependencies: [cryptoBackend]
        ),
        .target(
            name: "HappyWire"
        ),
        .target(
            name: "HappyStore",
            dependencies: [
                "HappyWire",
                .product(name: "GRDB", package: "GRDB.swift"),
            ]
        ),
        .target(
            name: "HappyCore",
            dependencies: [
                "HappyCrypto", "HappyWire", "HappyStore",
                .product(name: "GRDB", package: "GRDB.swift"),
                .product(name: "Tailcat", package: "tailcat-swift"),
            ]
        ),
        .target(
            // Product analytics (docs/analytics-catalog.json), on its own:
            // HappyCore never imports it. Deleting this target and the
            // facade's call sites in HappyUI and HappyApp removes it all.
            name: "HappyAnalytics",
            dependencies: ["HappyCore", "HappyWire", "HappyStore"]
        ),
        .target(
            // Foundation only, no UIKit: sizes in, frames out.
            name: "HappyLayout"
        ),
        .target(
            // happy-app's icon fonts as vector outlines: generated code, no
            // fonts at runtime. Foundation only, like HappyLayout.
            name: "HappyIcons",
            dependencies: ["HappyLayout"],
            exclude: ["LICENSES.md"]
        ),
        .target(
            name: "HappyUI",
            dependencies: [
                "HappyCore", "HappyAnalytics", "HappyCrypto", "HappyWire", "HappyStore", "HappyLayout", "HappyIcons",
                .product(name: "ElevenLabs", package: "elevenlabs-swift-sdk", condition: .when(platforms: [.iOS])),
                .product(name: "UltraView", package: "ultraview", condition: .when(platforms: [.iOS])),
                .product(name: "Lottie", package: "lottie-spm", condition: .when(platforms: [.iOS])),
            ],
            // Fonts and images live with the code that draws them, so
            // `Bundle.module` resolves the same way under xtool and Xcode.
            resources: [.process("Resources")]
        ),
        .target(
            name: "HappyApp",
            dependencies: ["HappyCore", "HappyAnalytics", "HappyStore", "HappyUI", "HappyGuestUI", "HappyGuest"]
        ),
        .testTarget(
            name: "HappyCryptoTests",
            dependencies: ["HappyCrypto"],
            resources: [.copy("Fixtures")]
        ),
        .testTarget(
            name: "HappyWireTests",
            dependencies: ["HappyWire"]
        ),
        .testTarget(
            name: "HappyStoreTests",
            dependencies: ["HappyStore"]
        ),
        .testTarget(
            name: "HappyCoreTests",
            dependencies: ["HappyCore", "HappyCrypto"],
            resources: [.copy("Fixtures")]
        ),
        .testTarget(
            name: "HappyAnalyticsTests",
            dependencies: ["HappyAnalytics", "HappyCore", "HappyStore"]
        ),
        .testTarget(
            name: "HappyLayoutTests",
            dependencies: ["HappyLayout"],
            resources: [.copy("Fixtures")]
        ),
        .testTarget(
            name: "HappyIconsTests",
            dependencies: ["HappyIcons", "HappyLayout"]
        ),
        .testTarget(
            // Needs UIKit to measure real views. Compiles to nothing on Linux;
            // runs in the iOS simulator through the XcodeGen project.
            name: "HappyUIKitTests",
            dependencies: ["HappyUI", "HappyLayout", "HappyIcons", "HappyCore"],
            // Read from the XcodeGen bundle, which copies them.
            exclude: ["Fixtures"]
        ),
    ]
)
