import type { Hono } from "hono";

/** Package of the Rakazo Android app (apps/mobile/app.json). */
const ANDROID_PACKAGE = "com.rakazo.app";

/**
 * Which native apps can use this server's passkeys: only those the domain vouches for
 * below. Without the association file the OS refuses every ceremony, so apps hide passkeys.
 */
export function nativePasskeys(
  env: { passkeyAppleAppIds: string[]; passkeyAndroidCertFingerprints: string[] },
  passkeyRpId: string | null,
): { ios: boolean; android: boolean } {
  return {
    ios: Boolean(passkeyRpId) && env.passkeyAppleAppIds.length > 0,
    android: Boolean(passkeyRpId) && env.passkeyAndroidCertFingerprints.length > 0,
  };
}

/** Each association file exists only when the deployment names its apps. */
export function mountAppAssociation(
  app: Hono,
  env: { passkeyAppleAppIds: string[]; passkeyAndroidCertFingerprints: string[] },
) {
  app.get("/.well-known/apple-app-site-association", (c) => {
    if (!env.passkeyAppleAppIds.length) return c.notFound();
    return c.json({ webcredentials: { apps: env.passkeyAppleAppIds } });
  });
  app.get("/.well-known/assetlinks.json", (c) => {
    if (!env.passkeyAndroidCertFingerprints.length) return c.notFound();
    return c.json([
      {
        relation: ["delegate_permission/common.get_login_creds"],
        target: {
          namespace: "android_app",
          package_name: ANDROID_PACKAGE,
          sha256_cert_fingerprints: env.passkeyAndroidCertFingerprints,
        },
      },
    ]);
  });
}
