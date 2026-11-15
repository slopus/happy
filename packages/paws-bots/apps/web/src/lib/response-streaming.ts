import { normalizeResponseStreamingPreference, RESPONSE_STREAMING_STORAGE_KEY } from "@rakazo/core";
import { createStoredPreference } from "./stored-preference";

/** Saved choice wins. Nothing saved leaves streaming off. */
export const responseStreamingPreference = createStoredPreference({
  key: RESPONSE_STREAMING_STORAGE_KEY,
  parse: (raw) => normalizeResponseStreamingPreference(raw) === "on",
  serialize: (enabled) => (enabled ? "on" : "off"),
});
