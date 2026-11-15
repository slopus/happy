import type { SpaceMemoryConfig } from "@rakazo/contracts";
import type { ComponentType, ReactNode } from "react";
import { HindsightSettingsForm } from "./HindsightSettingsForm";
import { HonchoSettingsForm } from "./HonchoSettingsForm";
import { SerenitySettingsForm } from "./SerenitySettingsForm";
import { SupermemorySettingsForm } from "./SupermemorySettingsForm";

export interface MemoryProviderConnectionDraft {
  settings: Record<string, string>;
  credentials: Record<string, string>;
}

export interface MemoryProviderSettingsFormProps {
  busy: boolean;
  advancedSettings: ReactNode;
  onConnect: (draft: MemoryProviderConnectionDraft) => Promise<boolean>;
}

export interface MemoryProviderSettingsRegistration {
  id: string;
  name: string;
  SettingsForm: ComponentType<MemoryProviderSettingsFormProps>;
  connectedLabel: (config: SpaceMemoryConfig) => string;
}

export const MEMORY_PROVIDER_SETTINGS: readonly MemoryProviderSettingsRegistration[] = [
  {
    id: "supermemory",
    name: "Supermemory",
    SettingsForm: SupermemorySettingsForm,
    connectedLabel: (config) =>
      config.settings.mode === "cloud"
        ? "Supermemory Cloud"
        : `Self-hosted (${config.settings.baseUrl})`,
  },
  {
    id: "serenity",
    name: "Serenity",
    SettingsForm: SerenitySettingsForm,
    connectedLabel: (config) => {
      const label = config.settings.brainLabel?.trim();
      const endpoint = config.settings.endpoint ?? "Serenity";
      const mode = config.settings.allowWrites === "true" ? "read/write" : "recall only";
      return `${label || endpoint}, ${mode}`;
    },
  },
  {
    id: "honcho",
    name: "Honcho",
    SettingsForm: HonchoSettingsForm,
    connectedLabel: (config) => {
      const { mode, baseUrl, workspaceId } = config.settings;
      if (mode === "local")
        return [`Self-hosted (${baseUrl})`, workspaceId].filter(Boolean).join(", ");
      return workspaceId ? `Honcho Cloud (${workspaceId})` : "Honcho Cloud";
    },
  },
  {
    id: "hindsight",
    name: "Hindsight",
    SettingsForm: HindsightSettingsForm,
    connectedLabel: (config) => {
      const { mode, baseUrl } = config.settings;
      return mode === "local" ? `Self-hosted (${baseUrl})` : "Hindsight Cloud";
    },
  },
];

export function memoryProviderSettings(provider: string) {
  return MEMORY_PROVIDER_SETTINGS.find((entry) => entry.id === provider) ?? null;
}

export function defaultMemoryProviderSettings(): MemoryProviderSettingsRegistration {
  const registration = MEMORY_PROVIDER_SETTINGS[0];
  if (!registration) throw new Error("No memory provider settings are registered.");
  return registration;
}
