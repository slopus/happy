export const REMOTE_IMAGES_STORAGE_KEY = "rakazo.loadRemoteImages";
export type RemoteImagesPreference = "on" | "off";

/**
 * Missing and unknown values stay off: a markdown image from the web waits for the reader's tap
 * unless they explicitly chose to load web images automatically on this device.
 */
export function normalizeRemoteImagesPreference(
  raw: string | null | undefined,
): RemoteImagesPreference {
  return raw?.trim().toLowerCase() === "on" ? "on" : "off";
}
