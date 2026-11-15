import type { ComputerProviderDescriptor } from "@rakazo/contracts";
import { boatComputerSettings } from "./boat-settings.js";
import { boxdComputerSettings } from "./boxd-settings.js";
import type { SettingsComputerProvider } from "./computer-provider-descriptor.js";
import { createosComputerSettings } from "./createos-settings.js";
import { daytonaComputerSettings } from "./daytona-settings.js";
import { e2bComputerSettings } from "./e2b-settings.js";
import { instaboxComputerSettings } from "./instabox-settings.js";
import { novitaComputerSettings } from "./novita-settings.js";
import { railwayComputerSettings } from "./railway-settings.js";
import { wuyingComputerSettings } from "./wuying-settings.js";

export const computerProviderRegistry: readonly SettingsComputerProvider[] = [
  wuyingComputerSettings,
  e2bComputerSettings,
  novitaComputerSettings,
  daytonaComputerSettings,
  createosComputerSettings,
  boatComputerSettings,
  boxdComputerSettings,
  instaboxComputerSettings,
  railwayComputerSettings,
];
export function computerProviderDescriptor(id: string) {
  const descriptor = computerProviderRegistry.find((entry) => entry.id === id);
  if (!descriptor) throw new Error("Unknown computer provider");
  return descriptor;
}
export function computerProviderDescriptors(perAccount = false): ComputerProviderDescriptor[] {
  return computerProviderRegistry
    .filter((entry) => !perAccount || entry.capabilities.perAccount)
    .map(({ id, displayName, fields, capabilities }) => ({
      id,
      displayName,
      fields,
      capabilities,
    }));
}
