import { normalizeRemoteImagesPreference, REMOTE_IMAGES_STORAGE_KEY } from "@rakazo/core";
import { createStoredPreference } from "./stored-preference";

/** Saved choice wins. Nothing saved keeps web images behind a tap. */
export const remoteImagesPreference = createStoredPreference({
  key: REMOTE_IMAGES_STORAGE_KEY,
  parse: (raw) => normalizeRemoteImagesPreference(raw) === "on",
  serialize: (enabled) => (enabled ? "on" : "off"),
});
