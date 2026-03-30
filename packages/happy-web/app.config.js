export default {
    expo: {
        name: "Happy Web",
        slug: "happy-web",
        version: "1.0.0",
        orientation: "default",
        scheme: "happy-web",
        web: {
            bundler: "metro",
            output: "single",
            favicon: "./sources/assets/images/favicon.png"
        },
        plugins: [
            [
                "expo-router",
                {
                    root: "./sources/app"
                }
            ]
        ],
        experiments: {
            typedRoutes: true
        },
        extra: {
            router: {
                root: "./sources/app"
            }
        }
    }
};
