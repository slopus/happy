import { messagingProviderLabel, messagingProviderName } from "@rakazo/core";

/** User-facing name of a messaging provider (falls back to the raw id). */
export const providerLabel = messagingProviderName;

/** Per-message provider label, narrowed to a recognized transport when available. */
export const messageProviderLabel = messagingProviderLabel;
