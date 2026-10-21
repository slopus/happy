// Explicit capture targets, not dimensions inferred from arbitrary image files.
export const profiles = {
    iphone: {
        platform: "ios",
        uiOnly: false,
        width: 660,
        height: 1434,
        headline: 66,
        support: 26,
        deviceWidth: 552,
        desktopWidth: 832,
        gutter: 40,
        top: 48,
        rawWidth: 1206,
        rawHeight: 2622,
    },
    ipad: {
        platform: "ios",
        uiOnly: false,
        width: 1032,
        height: 1376,
        headline: 76,
        support: 28,
        deviceWidth: 770,
        desktopWidth: 1080,
        gutter: 64,
        top: 40,
        rawWidth: 2064,
        rawHeight: 2752,
    },
    "android-phone": {
        platform: "android",
        uiOnly: false,
        width: 540,
        height: 960,
        headline: 42,
        support: 18,
        // Keep the native screen large; the original Android shell sits outside it.
        deviceWidth: 414,
        frameInset: 8,
        desktopWidth: 680,
        gutter: 32,
        top: 24,
        rawWidth: 1080,
        rawHeight: 1920,
    },
    "android-tablet-7": {
        platform: "android",
        uiOnly: true,
        width: 960,
        height: 540,
        rawWidth: 1920,
        rawHeight: 1080,
    },
    "android-tablet-10": {
        platform: "android",
        uiOnly: true,
        width: 960,
        height: 540,
        rawWidth: 1920,
        rawHeight: 1080,
    },
};

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const closed = (value, keys, label) => {
    if (!object(value) || Object.keys(value).some((key) => !keys.includes(key)))
        throw new Error(`${label} must contain only its declared fields.`);
};
const revision = (value) => typeof value === "string" && /^[a-f0-9]{40,64}$/u.test(value);
const text = (value, max) =>
    typeof value === "string" && value.trim().length > 0 && [...value].length <= max;

export function validateManifest(manifest) {
    if (!object(manifest) || manifest.version !== 2 || !Object.hasOwn(profiles, manifest.device))
        throw new Error("Expected a version-2 manifest with an explicit supported device target.");
    const profile = profiles[manifest.device];
    const android = profile.platform === "android";
    closed(
        manifest,
        [
            "version",
            "device",
            "provenance",
            "screens",
            ...(android ? ["altText"] : []),
            ...(!profile.uiOnly ? ["font", "supportFont"] : []),
        ],
        "Manifest",
    );
    if (!profile.uiOnly && (!text(manifest.font, 4096) || !text(manifest.supportFont, 4096)))
        throw new Error("Captioned compositions require explicit font and supportFont paths.");
    const sceneIds = [
        "models",
        "sessions",
        profile.uiOnly ? "companion" : "desktop",
        "multiplayer",
        "source",
    ];
    closed(manifest.screens, sceneIds, "Screens");
    if (sceneIds.some((id) => !text(manifest.screens[id], 4096)))
        throw new Error(`Explicit capture paths required: ${sceneIds.join(", ")}.`);
    if (android) {
        closed(manifest.altText, sceneIds, "Alt text");
        if (
            sceneIds.some(
                (id) =>
                    !text(manifest.altText[id], 140) ||
                    /[\u0000-\u001f\u007f]/u.test(manifest.altText[id]),
            )
        )
            throw new Error(
                "Each Android scene requires nonempty alt text of at most 140 characters without control characters.",
            );
    }
    const supplied = manifest.provenance;
    closed(
        supplied,
        [
            "mobileCommit",
            "mobileDirty",
            "capturedAt",
            "fixtures",
            ...(android ? ["android"] : ["simulator"]),
            ...(!profile.uiOnly ? ["desktopCommit", "desktopDirty"] : []),
        ],
        "Provenance",
    );
    if (
        !revision(supplied.mobileCommit) ||
        typeof supplied.mobileDirty !== "boolean" ||
        (!profile.uiOnly &&
            (!revision(supplied.desktopCommit) || typeof supplied.desktopDirty !== "boolean")) ||
        !text(supplied.capturedAt, 40) ||
        !Number.isFinite(Date.parse(supplied.capturedAt)) ||
        !Array.isArray(supplied.fixtures) ||
        supplied.fixtures.length > 20 ||
        supplied.fixtures.some((value) => !text(value, 512))
    )
        throw new Error("Invalid capture revision, capture time, or fixture descriptions.");
    if (android) {
        closed(supplied.android, ["serial", "avd", "api", "dpi"], "Android provenance");
        const { serial, avd, api, dpi } = supplied.android;
        if (
            typeof serial !== "string" ||
            !/^emulator-[0-9]{4,5}$/u.test(serial) ||
            typeof avd !== "string" ||
            !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(avd) ||
            !Number.isInteger(api) ||
            api < 21 ||
            api > 100 ||
            !Number.isInteger(dpi) ||
            dpi < 72 ||
            dpi > 1000
        )
            throw new Error(
                "Android provenance requires emulator serial, AVD name, API level, and DPI.",
            );
    } else if (
        typeof supplied.simulator !== "string" ||
        !/^[a-f0-9-]{36}$/iu.test(supplied.simulator)
    ) {
        throw new Error("Apple provenance requires a dedicated Simulator UUID.");
    }
    // Reconstruct the closed, non-secret report contract rather than copying
    // runtime objects, environment variables, account data, or auth material.
    const provenance = {
        mobileCommit: supplied.mobileCommit,
        mobileDirty: supplied.mobileDirty,
        ...(!profile.uiOnly
            ? { desktopCommit: supplied.desktopCommit, desktopDirty: supplied.desktopDirty }
            : {}),
        ...(android
            ? {
                  android: {
                      serial: supplied.android.serial,
                      avd: supplied.android.avd,
                      api: supplied.android.api,
                      dpi: supplied.android.dpi,
                  },
              }
            : { simulator: supplied.simulator }),
        capturedAt: supplied.capturedAt,
        fixtures: supplied.fixtures.map((value) => value),
    };
    return { profile, provenance };
}
