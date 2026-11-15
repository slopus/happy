import { useLingui } from "@lingui/react/macro";
import {
  Brain,
  Building2,
  CloudDownload,
  Cpu,
  CreditCard,
  Gauge,
  KeyRound,
  MessageCircle,
  Monitor,
  Settings,
  ShieldCheck,
  Volume2,
  Wallet,
} from "lucide-react";
import type { ComponentType } from "react";
import type { SettingsSection } from "./shell-overlay";

export type SettingsNavItem = {
  id: SettingsSection;
  label: string;
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  /** One line under the page title, only where the name alone does not say what the page is for. */
  description?: string;
};

/** The settings sections this deployment offers, in nav order; Space opens from its own menu. */
export function useSettingsNavItems(available: {
  messaging: boolean;
  wallet: boolean;
  computer: boolean;
  billing: boolean;
  updates: boolean;
}): SettingsNavItem[] {
  const { t } = useLingui();
  return [
    // Ordered by how many people need each page: the essentials, then optional features, then
    // the account's usage and admin pages.
    { id: "general", label: t`General`, icon: Settings },
    { id: "models", label: t`Models`, icon: Cpu, description: t`Which LLMs your bots use.` },
    {
      id: "confirmations",
      label: t`Approvals`,
      icon: ShieldCheck,
      description: t`When bots check with you before acting.`,
    },
    {
      id: "vault",
      label: t`Vault`,
      icon: KeyRound,
      description: t`Logins and keys your bots can use.`,
    },
    ...(available.wallet
      ? [
          {
            id: "wallet" as const,
            label: t`Wallet`,
            icon: Wallet,
            description: t`Where your bots pay from.`,
          },
        ]
      : []),
    {
      id: "memory",
      label: t`Memory`,
      icon: Brain,
      description: t`What your bots remember between chats.`,
    },
    {
      id: "voice",
      label: t`Voice`,
      icon: Volume2,
      description: t`Calls, dictation, and replies read aloud.`,
    },
    ...(available.messaging
      ? [
          {
            id: "messaging" as const,
            label: t`Messaging`,
            icon: MessageCircle,
            description: t`Chat with your bots from other apps.`,
          },
        ]
      : []),
    ...(available.computer
      ? [
          {
            id: "computer" as const,
            label: t`Computer`,
            icon: Monitor,
            description: t`The computer your bots work on.`,
          },
        ]
      : []),
    { id: "usage", label: t`Usage`, icon: Gauge },
    ...(available.billing ? [{ id: "billing" as const, label: t`Billing`, icon: CreditCard }] : []),
    { id: "organization", label: t`Organization`, icon: Building2 },
    ...(available.updates
      ? [{ id: "updates" as const, label: t`Updates`, icon: CloudDownload }]
      : []),
  ];
}
