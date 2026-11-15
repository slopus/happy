import { pawsFetch } from "../paws/runtime";
import { t } from "@lingui/core/macro";
import type { UserDeviceSummary } from "@rakazo/contracts";
import { USER_DEVICE_PATH, userDeviceListSchema } from "@rakazo/contracts";
import { readBoundedJsonResponse } from "@rakazo/core";

export async function listUserDevices(): Promise<UserDeviceSummary[]> {
  const response = await pawsFetch(USER_DEVICE_PATH, { signal: AbortSignal.timeout(8_000) });
  // Servers without user devices have no such route.
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(t`Could not load`);
  try {
    return userDeviceListSchema.parse(await readBoundedJsonResponse<unknown>(response, 64 * 1024))
      .devices;
  } catch {
    throw new Error(t`Could not load`);
  }
}

export async function removeUserDevice(deviceId: string): Promise<void> {
  const response = await pawsFetch(`${USER_DEVICE_PATH}/${encodeURIComponent(deviceId)}`, {
    method: "DELETE",
    signal: AbortSignal.timeout(8_000),
  });
  await response.body?.cancel();
  if (!response.ok && response.status !== 404) throw new Error(t`Could not remove`);
}
