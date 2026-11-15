import { useLingui } from "@lingui/react/macro";
import type { BotAvatarSet, SpaceMemoryConfig, UsageSummary } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@rakazo/ui-web";
import { ChevronLeft, ChevronRight, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApprovalRulesSettings } from "../components/ApprovalRulesSettings";
import { computersAreUnavailable } from "../components/ComputersUnavailableHint";
import { PlanUsage } from "../components/PlanUsage";
import { SETTINGS_CONTENT_WIDTH, SettingsGroup, SettingsRow } from "../components/SettingsRows";
import { VaultSettings } from "../components/VaultSettings";
import { canChooseOwnComputer } from "../lib/computer-sandbox";
import { desktopBridge } from "../lib/desktop";
import type { RpcClient } from "../lib/rpc";
import { SpaceRpcProvider } from "../lib/space-rpc";
import {
  ComputerSettingsPanel,
  GeneralSettingsPanels,
  UpdatesSettingsPanel,
  UsageSettingsPanel,
} from "./AccountSettingsOverlay";
import { BillingSettingsPanel } from "./BillingSettingsPanel";
import { MemorySettingsOverlay } from "./MemorySettingsOverlay";
import { MessagingSettingsPanel } from "./MessagingSettingsPanel";
import { ModelSettingsOverlay } from "./ModelSettingsOverlay";
import { OrganizationSettingsPanel } from "./OrganizationSettingsPanel";
import { PaymentWalletSettingsPanel } from "./PaymentWalletSettingsPanel";
import { SpaceSettingsPanel } from "./SpaceSettingsPanel";
import { useSettingsNavItems } from "./settings-nav";
import type { SettingsSpace } from "./shell/dialogs";
import type { SettingsSection } from "./shell-overlay";
import { VoiceSettingsOverlay } from "./VoiceSettingsOverlay";

export function SettingsOverlay({
  space,
  spaces = [],
  onOpenSpace,
  onRenameSpace,
  onDeleteSpace,
  email,
  name,
  usage,
  onUsageOpen,
  section: requestedSection,
  onSectionChange,
  onNameSaved,
  timezone,
  onTimezoneChange,
  botAvatarSet,
  onBotAvatarSetChange,
  onAccountImported,
  onImportAgent,
  billingEnabled = false,
  sandboxProvider,
  onSandboxProviderChange,
  canConfigureComputers = false,
  computerSettingsEnabled = false,
  messagingEnabled = false,
  paymentWalletProvider = null,
  memoryConfig,
  onMemoryConfigChange,
  onClose,
  onVoiceStatusMaybeChanged,
  onLeftSpace,
  shellRpc,
}: {
  /** The space the Space page edits; it need not be the selected space. */
  space?: SettingsSpace | null;
  spaces?: { id: string; name: string }[];
  onOpenSpace?: (spaceId: string) => void;
  onRenameSpace?: (spaceId: string, name: string) => Promise<void>;
  onDeleteSpace?: (spaceId: string) => Promise<void>;
  email?: string | null;
  name: string;
  usage?: UsageSummary | null;
  onUsageOpen: () => void;
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  onNameSaved?: () => Promise<void>;
  timezone: string | null;
  onTimezoneChange: (timezone: string) => Promise<void>;
  botAvatarSet?: BotAvatarSet;
  onBotAvatarSetChange?: (set: BotAvatarSet) => Promise<void>;
  onAccountImported?: () => Promise<void>;
  onImportAgent?: () => void;
  billingEnabled?: boolean;
  sandboxProvider?: string | null;
  onSandboxProviderChange?: (sandboxProvider: string) => void;
  /** Admins choose where new computers run. */
  canConfigureComputers?: boolean;
  computerSettingsEnabled?: boolean;
  messagingEnabled?: boolean;
  /** The wallet this deployment lets bots spend from; none hides Wallet. */
  paymentWalletProvider?: { id: string; name: string } | null;
  memoryConfig: SpaceMemoryConfig | null | undefined;
  onMemoryConfigChange: (config: SpaceMemoryConfig | null) => void;
  onClose: () => void;
  onVoiceStatusMaybeChanged?: () => void | Promise<void>;
  /** After leaving a space, with the space the server moved this person to. */
  onLeftSpace?: (spaceId: string, activeSpaceId: string) => void;
  /** Pinned to the space this window shows; billing acts on it. */
  shellRpc: RpcClient;
}) {
  const { t, i18n } = useLingui();
  const panelRef = useRef<HTMLDivElement>(null);
  // State, not a ref: the overflow watcher must follow the nav when it remounts.
  const [nav, setNav] = useState<HTMLElement | null>(null);
  const [navOverflow, setNavOverflow] = useState({ previous: false, next: false });
  const usageRef = useRef<HTMLDivElement>(null);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [keepComputerRecovery, setKeepComputerRecovery] = useState(false);
  const recoveryHoldTimer = useRef<number | undefined>(undefined);
  const showComputer =
    computerSettingsEnabled &&
    (canConfigureComputers ||
      canChooseOwnComputer(sandboxProvider) ||
      keepComputerRecovery ||
      computersAreUnavailable(sandboxProvider));
  const showUpdates = Boolean(desktopBridge()?.update);
  // A section that isn't available yet (billing before its flag loads) shows General until it is.
  const section =
    (requestedSection === "computer" && !showComputer) ||
    (requestedSection === "billing" && !billingEnabled) ||
    (requestedSection === "messaging" && !messagingEnabled) ||
    (requestedSection === "wallet" && !paymentWalletProvider) ||
    (requestedSection === "updates" && !showUpdates)
      ? "general"
      : requestedSection;
  const panelBusy = memoryBusy || voiceBusy;
  // Only a space's own page binds to it; every other section, memory included, acts on the
  // space the app is showing.
  const spaceId = section === "space" ? (space?.id ?? null) : undefined;
  const releaseComputerRecovery = useCallback(() => {
    window.clearTimeout(recoveryHoldTimer.current);
    recoveryHoldTimer.current = undefined;
    setKeepComputerRecovery(false);
  }, []);
  const holdComputerRecovery = useCallback(() => {
    setKeepComputerRecovery(true);
    window.clearTimeout(recoveryHoldTimer.current);
    recoveryHoldTimer.current = window.setTimeout(() => {
      recoveryHoldTimer.current = undefined;
      setKeepComputerRecovery(false);
    }, 4000);
  }, []);

  useEffect(() => {
    if (section !== "computer") releaseComputerRecovery();
  }, [section, releaseComputerRecovery]);
  useEffect(() => () => window.clearTimeout(recoveryHoldTimer.current), []);

  useEffect(() => {
    if (section === "usage") {
      onUsageOpen();
      usageRef.current?.focus();
    }
  }, [section, onUsageOpen]);

  const navItems = useSettingsNavItems({
    messaging: messagingEnabled,
    wallet: Boolean(paymentWalletProvider),
    computer: showComputer,
    billing: billingEnabled,
    updates: showUpdates,
  });

  useEffect(() => {
    if (!nav) return;
    const measure = () => {
      const offset = Math.abs(nav.scrollLeft);
      setNavOverflow({
        previous: offset > 1,
        next: nav.scrollWidth - nav.clientWidth - offset > 1,
      });
    };
    const revealSection = () => {
      if (nav.scrollWidth > nav.clientWidth) {
        nav.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView?.({
          block: "nearest",
          inline: "nearest",
        });
      }
      measure();
    };
    revealSection();
    nav.addEventListener("scroll", measure);
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(revealSection);
    observer?.observe(nav);
    return () => {
      nav.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [
    nav,
    section,
    showComputer,
    billingEnabled,
    messagingEnabled,
    paymentWalletProvider,
    showUpdates,
    i18n.locale,
  ]);

  function scrollSections(direction: number) {
    if (!nav) return;
    const rtl = getComputedStyle(nav).direction === "rtl";
    nav.scrollBy({ left: nav.clientWidth * 0.75 * direction * (rtl ? -1 : 1), behavior: "smooth" });
  }

  const sectionTitle =
    section === "space"
      ? (space?.name ?? t`Space`)
      : (navItems.find((item) => item.id === section)?.label ??
        (section === "general" ? t`General` : t`Settings`));

  const sectionDescription =
    section === "space" ? undefined : navItems.find((item) => item.id === section)?.description;

  const closeLabel =
    section === "models"
      ? t`Close model settings`
      : section === "memory"
        ? t`Close memory settings`
        : section === "voice"
          ? t`Close voice settings`
          : t`Close user settings`;

  async function refreshVoiceStatus() {
    await onVoiceStatusMaybeChanged?.();
  }

  // Leaving is immediate, so the URL updates in the same tick; voice readiness refreshes behind it.
  function leaveSettings(next: () => void) {
    if (panelBusy) return;
    void refreshVoiceStatus();
    next();
  }

  function requestClose() {
    leaveSettings(onClose);
  }

  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (open) return;
        if (panelBusy) {
          details.cancel();
          return;
        }
        requestClose();
      }}
    >
      <DialogContent
        ref={panelRef}
        data-testid="user-settings"
        data-settings-section={section}
        showCloseButton={false}
        initialFocus={() =>
          section === "usage" ? (usageRef.current ?? panelRef.current) : panelRef.current
        }
        className="flex h-[min(760px,calc(100%-2rem))] max-h-[calc(100%-2rem)] w-[min(1080px,calc(100%-2rem))] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-h-[calc(100%-5rem)] sm:max-w-[1080px]"
      >
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 md:contents">
            {/* Reserve arrow space so showing controls does not change the overflow measurement. */}
            <Button
              variant="ghost"
              size="icon-sm"
              className={`shrink-0 md:hidden ${navOverflow.previous || navOverflow.next ? "" : "invisible"}`}
              aria-label={t`Previous settings sections`}
              disabled={!navOverflow.previous || panelBusy}
              onClick={() => scrollSections(-1)}
            >
              <ChevronLeft className="rtl:rotate-180" />
            </Button>
            <nav
              ref={setNav}
              data-testid="settings-nav"
              aria-label={t`Settings`}
              className="flex min-w-0 flex-1 flex-row gap-1 overflow-x-auto py-3 md:w-[200px] md:shrink-0 md:flex-none md:flex-col md:overflow-y-auto md:border-e md:border-border md:bg-sidebar md:px-3 md:py-4"
            >
              {navItems.map((item) => {
                const Icon = item.icon;
                // A space's page is reached from General, so General stays marked.
                const active = item.id === (section === "space" ? "general" : section);
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-testid={`settings-nav-${item.id}`}
                    aria-current={active ? "page" : undefined}
                    disabled={panelBusy}
                    onClick={() => onSectionChange(item.id)}
                    className={`flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-body transition-colors disabled:pointer-events-none disabled:opacity-50 ${
                      active
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground"
                    }`}
                  >
                    <Icon className="size-4 shrink-0" strokeWidth={1.75} />
                    <span className="whitespace-nowrap">{item.label}</span>
                  </button>
                );
              })}
            </nav>
            <Button
              variant="ghost"
              size="icon-sm"
              className={`shrink-0 md:hidden ${navOverflow.previous || navOverflow.next ? "" : "invisible"}`}
              aria-label={t`Next settings sections`}
              disabled={!navOverflow.next || panelBusy}
              onClick={() => scrollSections(1)}
            >
              <ChevronRight className="rtl:rotate-180" />
            </Button>
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div
              data-testid="settings-header"
              className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-6 pb-5 pt-6 sm:px-8 sm:pt-7"
            >
              <div className="flex min-w-0 items-center gap-2">
                {section === "space" ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="-ms-2 shrink-0"
                    aria-label={t`Back`}
                    disabled={panelBusy}
                    onClick={() => onSectionChange("general")}
                  >
                    <ChevronLeft className="rtl:rotate-180" />
                  </Button>
                ) : null}
                <div className="min-w-0">
                  <DialogTitle className="break-words text-heading2 font-medium text-foreground">
                    {sectionTitle}
                  </DialogTitle>
                  {sectionDescription ? (
                    <DialogDescription className="mt-1 text-body text-muted-foreground">
                      {sectionDescription}
                    </DialogDescription>
                  ) : null}
                </div>
              </div>
              <DialogClose
                aria-label={closeLabel}
                disabled={panelBusy}
                render={<Button variant="ghost" size="icon-sm" />}
              >
                <XIcon />
              </DialogClose>
            </div>

            <SpaceRpcProvider spaceId={spaceId}>
              <div
                key={spaceId ?? "selected"}
                data-testid="settings-scroll"
                className={`min-h-0 flex-1 ${
                  section === "memory"
                    ? "flex flex-col overflow-hidden"
                    : "rk-scroll overflow-y-auto overscroll-contain px-6 pb-6 pt-6 sm:px-8 sm:pb-8"
                }`}
              >
                {/* Memory scrolls its own body and applies the same width there; Usage's table needs the room. */}
                <div
                  className={
                    section === "memory" || section === "usage"
                      ? "contents"
                      : SETTINGS_CONTENT_WIDTH
                  }
                >
                  {section === "general" ? (
                    <div className="space-y-8">
                      <GeneralSettingsPanels
                        email={email}
                        name={name}
                        onNameSaved={onNameSaved}
                        timezone={timezone}
                        onTimezoneChange={onTimezoneChange}
                        botAvatarSet={botAvatarSet}
                        onBotAvatarSetChange={onBotAvatarSetChange}
                        onAccountImported={onAccountImported}
                        onImportAgent={onImportAgent}
                      />
                      {/* One space is just the app, so there is nothing to tell apart or manage. */}
                      {spaces.length > 1 && onOpenSpace ? (
                        <SettingsGroup title={t`Spaces`} data-testid="settings-spaces">
                          {spaces.map((option) => (
                            <SettingsRow
                              key={option.id}
                              label={<p className="break-words">{option.name}</p>}
                              control={
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="rounded-full"
                                  aria-label={t`Manage ${option.name}`}
                                  onClick={() => onOpenSpace(option.id)}
                                >
                                  {t`Manage`}
                                </Button>
                              }
                            />
                          ))}
                        </SettingsGroup>
                      ) : null}
                    </div>
                  ) : null}
                  {section === "space" && space ? (
                    <SpaceSettingsPanel
                      key={space.id}
                      space={space}
                      onRename={(name) => onRenameSpace?.(space.id, name) ?? Promise.resolve()}
                      onDelete={() => onDeleteSpace?.(space.id) ?? Promise.resolve()}
                      onLeft={(activeSpaceId) => onLeftSpace?.(space.id, activeSpaceId)}
                      onClose={requestClose}
                      onBusyChange={setVoiceBusy}
                    />
                  ) : null}
                  {section === "organization" ? (
                    <OrganizationSettingsPanel onBusyChange={setVoiceBusy} />
                  ) : null}
                  {section === "confirmations" ? <ApprovalRulesSettings scope="account" /> : null}
                  {section === "vault" ? <VaultSettings scope="account" /> : null}
                  {section === "messaging" && messagingEnabled ? <MessagingSettingsPanel /> : null}
                  {section === "wallet" && paymentWalletProvider ? (
                    <PaymentWalletSettingsPanel provider={paymentWalletProvider} />
                  ) : null}
                  {section === "usage" ? (
                    <>
                      <PlanUsage />
                      <UsageSettingsPanel usage={usage} panelRef={usageRef} />
                    </>
                  ) : null}
                  {section === "computer" && showComputer ? (
                    <ComputerSettingsPanel
                      sandboxProvider={sandboxProvider}
                      onSandboxProviderChange={(next) => {
                        onSandboxProviderChange?.(next);
                        holdComputerRecovery();
                      }}
                      onRecoveryDismissed={releaseComputerRecovery}
                      canConfigureComputers={canConfigureComputers}
                      computerSettingsEnabled={computerSettingsEnabled}
                    />
                  ) : null}
                  {section === "billing" && billingEnabled ? (
                    <BillingSettingsPanel client={shellRpc} />
                  ) : null}
                  {section === "updates" && showUpdates ? <UpdatesSettingsPanel /> : null}
                  {section === "models" ? (
                    <ModelSettingsOverlay embedded scope="account" onClose={requestClose} />
                  ) : null}
                  {section === "memory" ? (
                    <MemorySettingsOverlay
                      embedded
                      onClose={requestClose}
                      config={memoryConfig}
                      onConfigChange={onMemoryConfigChange}
                      onBusyChange={setMemoryBusy}
                    />
                  ) : null}
                  {section === "voice" ? (
                    <VoiceSettingsOverlay
                      embedded
                      scope="account"
                      onClose={requestClose}
                      onBusyChange={setVoiceBusy}
                    />
                  ) : null}
                </div>
              </div>
            </SpaceRpcProvider>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
