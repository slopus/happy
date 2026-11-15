import { Trans, useLingui } from "@lingui/react/macro";
import type { RakazoDesktop, UserDeviceSummary } from "@rakazo/contracts";
import { Button, Label, Switch } from "@rakazo/ui-web";
import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { desktopBridge } from "../lib/desktop";
import { rpc } from "../lib/rpc";
import { listUserDevices, removeUserDevice } from "../lib/user-devices";
import { SettingsGroup, SettingsRow } from "./SettingsRows";

type ThisComputer = { allowed: boolean; setAllowed: (allowed: boolean) => Promise<unknown> };

/** A remote server pairs this computer; the app-managed local stack runs bots on it directly. */
async function thisComputerAccess(
  desktop: RakazoDesktop | undefined,
): Promise<ThisComputer | null> {
  const device = desktop?.device;
  const paired = await device?.state().catch(() => null);
  if (device && paired) return { allowed: paired.allowed, setAllowed: device.setAllowed };
  const computer = desktop?.computer;
  if (!computer?.managesHostChoice) return null;
  const me = await rpc.me();
  if (!me.canChooseHostComputer) return null;
  return {
    allowed: me.computerHost === "this-mac",
    setAllowed: (allowed) => (allowed ? computer.requestAccess() : computer.revokeAccess()),
  };
}

export function ComputerDeviceSettings() {
  const { t } = useLingui();
  const desktop = desktopBridge();
  const [devices, setDevices] = useState<UserDeviceSummary[]>([]);
  const [thisComputer, setThisComputer] = useState<ThisComputer | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const switchId = useId();

  const load = useCallback(async () => {
    const [listed, local] = await Promise.all([
      listUserDevices().catch(() => null),
      // A failed profile read keeps the last known switch rather than hiding it.
      thisComputerAccess(desktop).catch(() => undefined),
    ]);
    if (listed) setDevices(listed);
    if (local !== undefined) setThisComputer(local);
  }, [desktop]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>, failure: string) {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch {
      setError(failure);
    } finally {
      await load();
      setPending(false);
    }
  }

  if (devices.length === 0 && !thisComputer) return null;

  return (
    <SettingsGroup title={<Trans>Computers</Trans>} data-testid="computer-devices">
      {thisComputer ? (
        <SettingsRow
          label={
            <Label htmlFor={switchId} className="text-body font-normal text-foreground">
              <Trans>Let bots use this computer</Trans>
            </Label>
          }
          control={
            <Switch
              id={switchId}
              data-testid="this-computer-toggle"
              checked={thisComputer.allowed}
              disabled={pending}
              onCheckedChange={(allowed) =>
                void run(() => thisComputer.setAllowed(allowed), t`Could not change`)
              }
            />
          }
        />
      ) : null}
      {devices.map((device) => (
        <SettingsRow
          key={device.deviceId}
          label={
            <p className="flex min-w-0 items-baseline gap-2">
              <span className="truncate">{device.name}</span>
              <span className="shrink-0 text-body-sm text-muted-foreground">
                {device.connected ? <Trans>Connected</Trans> : <Trans>Offline</Trans>}
              </span>
            </p>
          }
          control={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t`Remove ${device.name}`}
              disabled={pending}
              className="text-destructive hover:text-destructive"
              onClick={() => void run(() => removeUserDevice(device.deviceId), t`Could not remove`)}
            >
              <Trash2 />
            </Button>
          }
        />
      ))}
      {error ? (
        <p role="alert" className="px-4 py-3 text-body-sm text-destructive">
          {error}
        </p>
      ) : null}
    </SettingsGroup>
  );
}
