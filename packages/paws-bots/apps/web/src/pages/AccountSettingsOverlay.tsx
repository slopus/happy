import { Trans, useLingui } from "@lingui/react/macro";
import type {
  AccountSecurity,
  BotAvatarSet,
  SignInProvider,
  UsageSummary,
} from "@rakazo/contracts";
import {
  APP_LOCALE_LABELS,
  accountDisplay,
  displayName,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from "@rakazo/core";
import {
  Button,
  Field,
  FieldLabel,
  Input,
  Label,
  NativeSelect,
  NativeSelectOption,
  OptionSelect,
  SectionHeading,
  Switch,
  ToggleGroup,
  ToggleGroupItem,
} from "@rakazo/ui-web";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@rakazo/ui-web/components/ui/table";
import type { RefObject } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { AccountAccess, LinkSsoRow } from "../components/AccountAccess";
import { AccountDataSettings } from "../components/AccountDataSettings";
import { SuccessPop } from "../components/ai/primitives";
import { ComputerDeviceSettings } from "../components/ComputerDeviceSettings";
import { ComputerProviderSettings } from "../components/ComputerProviderSettings";
import {
  ComputersUnavailableHint,
  computersAreUnavailable,
} from "../components/ComputersUnavailableHint";
import { DesktopUpdateSection } from "../components/DesktopUpdates";
import { PasskeySettings } from "../components/PasskeySettings";
import { SettingsGroup, SettingsRow } from "../components/SettingsRows";
import { TrustedLinkSitesSettings } from "../components/TrustedLinkSitesSettings";
import { authClient } from "../lib/auth";
import { fetchAuthCapabilities } from "../lib/auth-capabilities";
import type { BotsSidebarDensity } from "../lib/bots-sidebar-density-pref";
import { botsSidebarDensityPreference } from "../lib/bots-sidebar-density-pref";
import { composerEnterToSendPreference } from "../lib/composer-enter-to-send-pref";
import { getActiveUiLocale, setUiLocale } from "../lib/i18n";
import { localTimezone, sameTimeZone, timezoneOptions } from "../lib/local-timezone";
import { usePasskeysSupported } from "../lib/passkeys";
import { remoteImagesPreference } from "../lib/remote-images-preference";
import { responseStreamingPreference } from "../lib/response-streaming";
import { toolActivityPreference } from "../lib/tool-activity-preference";
import type { AppearancePreference } from "../lib/ui-appearance";
import { getUiAppearancePreference, setUiAppearance } from "../lib/ui-appearance";
import type { UiLocale } from "../lib/ui-locale";
import { UI_LOCALES } from "../lib/ui-locale";
import { authErrorText } from "../lib/user-error";

export type SettingsGeneralProps = {
  email?: string | null;
  name: string;
  onNameSaved?: () => Promise<void>;
  /** The user's saved IANA timezone, or null before one is set. */
  timezone?: string | null;
  onTimezoneChange?: (timezone: string) => Promise<void>;
  /** The icon set new and unpinned bots wear; absent from servers that predate it. */
  botAvatarSet?: BotAvatarSet;
  onBotAvatarSetChange?: (set: BotAvatarSet) => Promise<void>;
  onAccountImported?: () => Promise<void>;
  onImportAgent?: () => void;
};

export function GeneralSettingsPanels({
  email,
  name,
  onNameSaved,
  timezone = null,
  onTimezoneChange,
  botAvatarSet,
  onBotAvatarSetChange,
  onAccountImported,
  onImportAgent,
}: SettingsGeneralProps) {
  const { t } = useLingui();
  const account = accountDisplay({ name, email }, t`You`);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [namePending, setNamePending] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const nameId = useId();

  async function saveName() {
    const nextName = nameDraft.trim();
    if (namePending || !nextName || nextName.length > 80) return;
    if (!displayName(nextName, "")) {
      setNameError(t`Could not update name`);
      return;
    }
    // Nothing to save, so close without a request that could only fail.
    if (nextName === (account.label === email ? "" : displayName(name, ""))) {
      setNameError(null);
      setEditingName(false);
      return;
    }
    setNamePending(true);
    setNameError(null);
    try {
      const result = await authClient.updateUser({ name: nextName });
      if (result.error) {
        setNameError(authErrorText(result.error, t`Could not update name`));
        return;
      }
      setEditingName(false);
      void Promise.resolve()
        .then(() => onNameSaved?.())
        .catch(() => undefined);
    } catch {
      setNameError(t`Could not update name`);
    } finally {
      setNamePending(false);
    }
  }

  const [accountSecurity, setAccountSecurity] = useState<AccountSecurity | null>(null);
  const [locale, setLocale] = useState<UiLocale>(() => getActiveUiLocale());
  const localeRequestRef = useRef(0);
  const [appearance, setAppearance] = useState<AppearancePreference>(() =>
    getUiAppearancePreference(),
  );
  const sidebarDensity = botsSidebarDensityPreference.use();
  const sidebarDensityLabelId = useId();
  const botStyleLabelId = useId();
  const [botStyleError, setBotStyleError] = useState<string | null>(null);
  const streamReplies = responseStreamingPreference.use();
  const streamRepliesId = useId();
  const showToolActivity = toolActivityPreference.use();
  const showToolActivityId = useId();
  const enterToSend = composerEnterToSendPreference.use();
  const enterToSendId = useId();
  const loadRemoteImages = remoteImagesPreference.use();
  const loadRemoteImagesId = useId();
  const timezoneId = useId();
  const showPassword = Boolean(
    accountSecurity?.hasPassword && accountSecurity.passwordChangeEnabled !== false,
  );
  const [providers, setProviders] = useState<SignInProvider[]>([]);
  const passkeysSupported = usePasskeysSupported();
  useEffect(() => {
    let active = true;
    void fetchAuthCapabilities()
      .then((value) => {
        if (active) setProviders(value.providers ?? []);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  const unlinkedProviders = accountSecurity?.linkedProviderIds
    ? providers.filter(
        (provider) =>
          provider.id !== "oidc" && !accountSecurity.linkedProviderIds?.includes(provider.id),
      )
    : [];
  const canLinkSso = Boolean(accountSecurity?.sso && !accountSecurity.ssoLinked);
  const [timezonePending, setTimezonePending] = useState(false);
  const [timezoneError, setTimezoneError] = useState<string | null>(null);
  const deviceTimezone = localTimezone();
  const selectedTimezone = timezone ?? deviceTimezone;

  function chooseLocale(next: UiLocale) {
    if (next === locale) return;
    const requestId = ++localeRequestRef.current;
    setLocale(next);
    void setUiLocale(next).then((activated) => {
      if (requestId !== localeRequestRef.current) return;
      setLocale(activated);
    });
  }

  async function chooseTimezone(next: string) {
    if (!onTimezoneChange || timezonePending || next === timezone) return;
    setTimezonePending(true);
    setTimezoneError(null);
    try {
      await onTimezoneChange(next);
    } catch {
      setTimezoneError(t`Couldn't update your timezone`);
    } finally {
      setTimezonePending(false);
    }
  }

  return (
    <div className="space-y-8">
      <SettingsGroup title={<Trans>Account</Trans>} data-testid="account-card">
        {editingName ? (
          <form
            className="space-y-3 px-4 py-4"
            onSubmit={(event) => {
              event.preventDefault();
              void saveName();
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (!namePending) setEditingName(false);
              }
            }}
          >
            <Field>
              <FieldLabel htmlFor={nameId}>
                <Trans>Name</Trans>
              </FieldLabel>
              <Input
                id={nameId}
                autoComplete="name"
                autoFocus
                maxLength={80}
                value={nameDraft}
                disabled={namePending}
                onChange={(event) => {
                  setNameDraft(event.target.value);
                  setNameError(null);
                }}
              />
            </Field>
            {nameError ? (
              <p role="alert" className="text-body-sm text-destructive">
                {nameError}
              </p>
            ) : null}
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={namePending || !nameDraft.trim()}>
                <Trans>Save</Trans>
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={namePending}
                onClick={() => setEditingName(false)}
              >
                <Trans>Cancel</Trans>
              </Button>
            </div>
          </form>
        ) : (
          <SettingsRow
            label={
              <>
                <p className="break-words">{account.label}</p>
                {email && account.label !== email ? (
                  <p className="mt-0.5 break-words text-body-sm text-muted-foreground">{email}</p>
                ) : null}
              </>
            }
            control={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setNameDraft(account.label === email ? "" : displayName(name, ""));
                  setNameError(null);
                  setEditingName(true);
                }}
              >
                <Trans>Edit</Trans>
              </Button>
            }
          />
        )}
      </SettingsGroup>

      <SettingsGroup title={<Trans>Preferences</Trans>}>
        <SettingsRow
          label={<Trans>Appearance</Trans>}
          control={
            <AppearancePicker
              value={appearance}
              onChange={(next) => {
                setAppearance(next);
                setUiAppearance(next);
              }}
            />
          }
        />
        {onBotAvatarSetChange ? (
          <SettingsRow
            label={
              <span id={botStyleLabelId}>
                <Trans>Bot style</Trans>
              </span>
            }
            control={
              <div className="space-y-1">
                <ToggleGroup
                  aria-labelledby={botStyleLabelId}
                  data-testid="bot-style-select"
                  value={botAvatarSet ? [botAvatarSet] : []}
                  onValueChange={([next]) => {
                    if (!next || next === botAvatarSet) return;
                    setBotStyleError(null);
                    onBotAvatarSetChange(next as BotAvatarSet).catch(() =>
                      setBotStyleError(t`Couldn't update bot style`),
                    );
                  }}
                  spacing={1}
                  className="grid min-w-0 grid-cols-2 rounded-lg bg-muted p-1"
                >
                  <ToggleGroupItem
                    value="organic"
                    className="text-body-sm aria-pressed:bg-background aria-pressed:shadow-sm"
                  >
                    <Trans>Original</Trans>
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    value="rakazo"
                    className="text-body-sm aria-pressed:bg-background aria-pressed:shadow-sm"
                  >
                    <Trans>Rakazo</Trans>
                  </ToggleGroupItem>
                </ToggleGroup>
                {botStyleError ? (
                  <p role="alert" className="text-body-sm text-destructive">
                    {botStyleError}
                  </p>
                ) : null}
              </div>
            }
          />
        ) : null}
        <SettingsRow
          label={
            <span id={sidebarDensityLabelId}>
              <Trans>Sidebar density</Trans>
            </span>
          }
          control={
            <ToggleGroup
              aria-labelledby={sidebarDensityLabelId}
              data-testid="bots-sidebar-density-select"
              value={[sidebarDensity]}
              onValueChange={([next]) => {
                if (next) botsSidebarDensityPreference.set(next as BotsSidebarDensity);
              }}
              spacing={1}
              className="grid min-w-0 grid-cols-2 rounded-lg bg-muted p-1"
            >
              <ToggleGroupItem
                value="comfortable"
                data-testid="bots-sidebar-density-comfortable"
                className="text-body-sm aria-pressed:bg-background aria-pressed:shadow-sm"
              >
                <Trans>Comfortable</Trans>
              </ToggleGroupItem>
              <ToggleGroupItem
                value="compact"
                data-testid="bots-sidebar-density-compact"
                className="text-body-sm aria-pressed:bg-background aria-pressed:shadow-sm"
              >
                <Trans>Compact</Trans>
              </ToggleGroupItem>
            </ToggleGroup>
          }
        />
        <SettingsRow
          label={<Trans>Language</Trans>}
          control={<UiLocalePicker value={locale} onChange={chooseLocale} />}
        />
        {onTimezoneChange ? (
          <div data-testid="timezone-settings">
            <SettingsRow
              label={
                <span id={timezoneId}>
                  <Trans>Timezone</Trans>
                </span>
              }
              control={
                <NativeSelect
                  aria-labelledby={timezoneId}
                  data-testid="timezone-select"
                  value={selectedTimezone}
                  disabled={timezonePending}
                  onChange={(event) => void chooseTimezone(event.target.value)}
                  className="w-56 max-w-full"
                >
                  {timezoneOptions(selectedTimezone).map((zone) => (
                    <NativeSelectOption key={zone} value={zone}>
                      {zone.replaceAll("_", " ")}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              }
            >
              {!sameTimeZone(selectedTimezone, deviceTimezone) ? (
                <div className="mt-2 flex justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-auto max-w-full py-1.5 text-left whitespace-normal"
                    disabled={timezonePending}
                    data-testid="timezone-use-device"
                    onClick={() => void chooseTimezone(deviceTimezone)}
                  >
                    <Trans comment="Switches the saved timezone to this device's, e.g. 'Use Pacific/Auckland'">
                      Use {deviceTimezone.replaceAll("_", " ")}
                    </Trans>
                  </Button>
                </div>
              ) : null}
              {timezoneError ? (
                <p role="alert" className="mt-2 text-right text-body-sm text-destructive">
                  {timezoneError}
                </p>
              ) : null}
            </SettingsRow>
          </div>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title={<Trans>Chat</Trans>}>
        <SettingsRow
          label={
            <Label htmlFor={enterToSendId} className="text-body font-normal text-foreground">
              <Trans>Send with Enter</Trans>
            </Label>
          }
          control={
            <Switch
              id={enterToSendId}
              data-testid="composer-enter-to-send-toggle"
              checked={enterToSend}
              onCheckedChange={(checked) => composerEnterToSendPreference.set(checked)}
            />
          }
        />
        <SettingsRow
          label={
            <Label htmlFor={streamRepliesId} className="text-body font-normal text-foreground">
              <Trans>Stream replies</Trans>
            </Label>
          }
          control={
            <Switch
              id={streamRepliesId}
              data-testid="response-streaming-toggle"
              checked={streamReplies}
              onCheckedChange={(checked) => responseStreamingPreference.set(checked)}
            />
          }
        />
        <SettingsRow
          label={
            <Label htmlFor={showToolActivityId} className="text-body font-normal text-foreground">
              <Trans>Show tool activity</Trans>
            </Label>
          }
          control={
            <Switch
              id={showToolActivityId}
              data-testid="tool-activity-toggle"
              checked={showToolActivity}
              onCheckedChange={(checked) => toolActivityPreference.set(checked)}
            />
          }
        />
        <SettingsRow
          label={
            <Label htmlFor={loadRemoteImagesId} className="text-body font-normal text-foreground">
              <Trans>Load web images automatically</Trans>
            </Label>
          }
          control={
            <Switch
              id={loadRemoteImagesId}
              data-testid="remote-images-toggle"
              checked={loadRemoteImages}
              onCheckedChange={(checked) => remoteImagesPreference.set(checked)}
            />
          }
        />
      </SettingsGroup>

      <TrustedLinkSitesSettings />
      <ComputerDeviceSettings />

      {showPassword || canLinkSso || passkeysSupported || unlinkedProviders.length > 0 ? (
        <SettingsGroup title={<Trans>Security</Trans>}>
          {showPassword ? <ChangePasswordRow email={email} /> : null}
          {canLinkSso ? (
            <LinkSsoRow
              provider={
                accountSecurity?.sso ? { id: "oidc", name: accountSecurity.sso.name } : undefined
              }
              onSecurity={setAccountSecurity}
            />
          ) : null}
          {unlinkedProviders.map((provider) => (
            <LinkSsoRow key={provider.id} provider={provider} onSecurity={setAccountSecurity} />
          ))}
          <PasskeySettings />
        </SettingsGroup>
      ) : null}

      <SettingsGroup title={<Trans>Data</Trans>} data-testid="account-data">
        <AccountDataSettings onImported={onAccountImported} onImportAgent={onImportAgent} />
        <AccountAccess onSecurity={setAccountSecurity} />
      </SettingsGroup>
    </div>
  );
}

export function UsageSettingsPanel({
  usage,
  panelRef,
}: {
  usage?: UsageSummary | null;
  panelRef?: RefObject<HTMLDivElement | null>;
}) {
  const { t, i18n } = useLingui();
  const count = new Intl.NumberFormat(i18n.locale);
  const usd = new Intl.NumberFormat(i18n.locale, {
    style: "currency",
    currency: "USD",
  });
  const number = (value: number | null | undefined) => (value == null ? "—" : count.format(value));
  const cost = (value: number | null | undefined) =>
    value == null ? "—" : value > 0 && value < 0.01 ? `<${usd.format(0.01)}` : usd.format(value);
  const models = usage?.models ?? [];
  return (
    <div ref={panelRef} tabIndex={-1} data-testid="usage-settings" className="outline-none">
      {usage ? (
        <dl className="grid grid-cols-3 gap-3">
          {[
            { label: t`Runs`, value: number(usage.runs) },
            { label: t`Tokens`, value: number(usage.totalTokens) },
            { label: t`Cost`, value: cost(usage.costUsd) },
          ].map((stat) => (
            <div key={stat.label} className="rounded-xl border border-border px-4 py-3">
              <dt className="text-body-sm text-muted-foreground">{stat.label}</dt>
              <dd className="mt-1 text-heading3 font-medium tabular-nums text-foreground">
                {stat.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {models.length > 0 ? (
        <div className="mt-4 rounded-xl border border-border px-2">
          <Table className="text-body">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="text-muted-foreground">
                  <Trans>Model</Trans>
                </TableHead>
                <TableHead className="text-right text-muted-foreground">
                  <Trans>Calls</Trans>
                </TableHead>
                <TableHead className="text-right text-muted-foreground">
                  <Trans>Input</Trans>
                </TableHead>
                <TableHead className="text-right text-muted-foreground">
                  <Trans>Output</Trans>
                </TableHead>
                <TableHead className="text-right text-muted-foreground">
                  <Trans>Cost</Trans>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.map((row) => (
                <TableRow key={`${row.provider}:${row.model}`} className="hover:bg-transparent">
                  <TableCell>
                    <div className="text-foreground">{row.model}</div>
                    <div className="text-label text-muted-foreground">{row.provider}</div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {number(row.modelCalls)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {number(row.inputTokens)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {number(row.outputTokens)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{cost(row.costUsd)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </div>
  );
}

export function ComputerSettingsPanel({
  sandboxProvider,
  onSandboxProviderChange,
  onRecoveryDismissed,
  canConfigureComputers = false,
  computerSettingsEnabled = false,
}: {
  sandboxProvider?: string | null;
  onSandboxProviderChange?: (sandboxProvider: string) => void;
  onRecoveryDismissed?: () => void;
  canConfigureComputers?: boolean;
  computerSettingsEnabled?: boolean;
}) {
  // Once shown, the hint stays mounted so a successful check can show its confirmation.
  const unavailable = computersAreUnavailable(sandboxProvider);
  const [hintShown, setHintShown] = useState(unavailable);
  if (unavailable && !hintShown) setHintShown(true);
  return (
    <div
      data-testid="computers-setup-settings"
      className="rounded-xl border border-border px-4 py-4"
    >
      <SectionHeading variant="heading">
        <Trans>Computers</Trans>
      </SectionHeading>
      {hintShown ? (
        <ComputersUnavailableHint
          className="mt-3 text-body-sm leading-relaxed text-muted-foreground"
          sandboxProvider={sandboxProvider}
          onRecovered={onSandboxProviderChange}
          onRecoveryDismissed={onRecoveryDismissed}
        />
      ) : null}
      {/* The server decides what an account may change, including removing keys it saved. */}
      {computerSettingsEnabled && (canConfigureComputers || sandboxProvider) ? (
        <ComputerProviderSettings
          scope={canConfigureComputers ? "deployment" : "account"}
          onProviderChange={onSandboxProviderChange}
        />
      ) : null}
    </div>
  );
}

export function UpdatesSettingsPanel() {
  return (
    <div className="space-y-5">
      <DesktopUpdateSection />
    </div>
  );
}

function ChangePasswordRow({ email }: { email?: string | null }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function changePassword() {
    if (pending) return;
    if (newPassword !== confirmation) {
      setError(t`Passwords do not match`);
      return;
    }
    setPending(true);
    setSaved(false);
    setError(null);
    try {
      const result = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      if (result.error) {
        setError(authErrorText(result.error, t`Could not change password`));
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      setOpen(false);
      setSaved(true);
    } catch {
      setError(t`Could not reach the server`);
    } finally {
      setPending(false);
    }
  }

  function close() {
    setOpen(false);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmation("");
    setError(null);
  }

  return (
    <SettingsRow
      label={<Trans>Password</Trans>}
      control={
        open ? null : (
          <>
            {saved ? <SuccessPop label={t`Password updated`} /> : null}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setSaved(false);
                setOpen(true);
              }}
            >
              <Trans>Change password</Trans>
            </Button>
          </>
        )
      }
    >
      {open ? (
        <form
          className="mt-3"
          onSubmit={(event) => {
            event.preventDefault();
            void changePassword();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !pending) {
              event.stopPropagation();
              close();
            }
          }}
        >
          <div className="grid gap-3">
            <input
              type="text"
              name="username"
              autoComplete="username"
              value={email ?? ""}
              readOnly
              tabIndex={-1}
              aria-hidden="true"
              className="sr-only"
            />
            <SettingsPasswordInput
              label={t`Current password`}
              autoComplete="current-password"
              autoFocus
              value={currentPassword}
              onChange={setCurrentPassword}
            />
            <SettingsPasswordInput
              label={t`New password`}
              autoComplete="new-password"
              value={newPassword}
              onChange={setNewPassword}
            />
            <SettingsPasswordInput
              label={t`Confirm password`}
              autoComplete="new-password"
              value={confirmation}
              onChange={setConfirmation}
            />
          </div>
          {error ? (
            <p role="alert" className="mt-3 text-body-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="mt-4 flex items-center gap-3">
            <Button type="submit" disabled={pending || !currentPassword || !newPassword}>
              {pending ? <Trans>Changing…</Trans> : <Trans>Save</Trans>}
            </Button>
            <Button type="button" variant="ghost" disabled={pending} onClick={close}>
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </form>
      ) : null}
    </SettingsRow>
  );
}

function SettingsPasswordInput({
  label,
  autoComplete,
  autoFocus,
  value,
  onChange,
}: {
  label: string;
  autoComplete: "current-password" | "new-password";
  autoFocus?: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="password"
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        minLength={autoComplete === "new-password" ? MIN_PASSWORD_LENGTH : undefined}
        maxLength={MAX_PASSWORD_LENGTH}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

function AppearancePicker({
  value,
  onChange,
}: {
  value: AppearancePreference;
  onChange: (next: AppearancePreference) => void;
}) {
  const { t } = useLingui();
  const options: { value: AppearancePreference; label: string }[] = [
    { value: "system", label: t`System` },
    { value: "light", label: t`Light` },
    { value: "dark", label: t`Dark` },
  ];

  return (
    <ToggleGroup
      aria-label={t`Appearance`}
      data-testid="ui-appearance-select"
      value={[value]}
      onValueChange={([next]) => {
        if (next) onChange(next as AppearancePreference);
      }}
      spacing={1}
      className="grid min-w-0 grid-cols-3 rounded-lg bg-muted p-1"
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          data-testid={`ui-appearance-${option.value}`}
          className="text-body-sm aria-pressed:bg-background aria-pressed:shadow-sm"
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function UiLocalePicker({
  value,
  onChange,
}: {
  value: UiLocale;
  onChange: (locale: UiLocale) => void;
}) {
  const { t } = useLingui();
  return (
    <OptionSelect
      className="w-56 max-w-full"
      data-testid="ui-locale-select"
      aria-label={t`Language`}
      options={UI_LOCALES.map((code) => ({
        value: code,
        label: APP_LOCALE_LABELS[code],
      }))}
      value={value}
      onValueChange={onChange}
    />
  );
}
