import { useLingui } from "@lingui/react/macro";
import {
  Keyboard,
  LayoutTemplate,
  Lock,
  Monitor,
  Moon,
  Plug,
  Plus,
  ScrollText,
  Sun,
  Users,
} from "lucide-react";
import type { AppearancePreference } from "../../lib/ui-appearance";
import { getUiAppearancePreference, setUiAppearance } from "../../lib/ui-appearance";
import { useSettingsNavItems } from "../settings-nav";
import type { SettingsSection, ShellOverlay } from "../shell-overlay";
import type { CommandPaletteAction } from "./command-palette";

/** What the command menu offers: create, connect, settings sections, and appearance. */
export function usePaletteActions({
  settingsAvailable,
  onNewBot,
  onNewGroup,
  onNewSpace,
  onShortcuts,
  setOverlay,
  openSettings,
}: {
  settingsAvailable: Parameters<typeof useSettingsNavItems>[0];
  onNewBot: () => void;
  onNewGroup: () => void;
  onNewSpace: () => void;
  onShortcuts: () => void;
  setOverlay: (overlay: ShellOverlay) => void;
  openSettings: (section: SettingsSection) => void;
}): CommandPaletteAction[] {
  const { t } = useLingui();
  const settingsNavItems = useSettingsNavItems(settingsAvailable);
  return [
    {
      id: "new-bot",
      label: t`New bot`,
      icon: Plus,
      onSelect: onNewBot,
    },
    {
      id: "new-group",
      label: t`New group chat`,
      icon: Users,
      onSelect: onNewGroup,
    },
    {
      id: "new-space",
      label: t`New private space`,
      icon: Lock,
      onSelect: onNewSpace,
    },
    {
      id: "integrations",
      label: t`Connect apps`,
      icon: Plug,
      onSelect: () => setOverlay({ kind: "integrations" }),
    },
    {
      id: "bot-templates",
      label: t`Bot templates`,
      icon: LayoutTemplate,
      onSelect: () => setOverlay({ kind: "templates" }),
    },
    {
      id: "keyboard-shortcuts",
      label: t`Keyboard shortcuts`,
      icon: Keyboard,
      onSelect: onShortcuts,
    },
    {
      id: "skills",
      label: t`Skills`,
      icon: ScrollText,
      onSelect: () => setOverlay({ kind: "skills" }),
    },
    ...settingsNavItems.map(({ id, label, icon }) => ({
      id: `settings-${id}`,
      label: t`Settings: ${label}`,
      icon,
      onSelect: () => openSettings(id),
    })),
    ...(
      [
        { value: "system", label: t`System`, icon: Monitor },
        { value: "light", label: t`Light`, icon: Sun },
        { value: "dark", label: t`Dark`, icon: Moon },
      ] satisfies { value: AppearancePreference; label: string; icon: typeof Sun }[]
    ).map(({ value, label, icon }) => ({
      id: `appearance-${value}`,
      label: t`Appearance: ${label}`,
      icon,
      checked: getUiAppearancePreference() === value,
      onSelect: () => setUiAppearance(value),
    })),
  ];
}
