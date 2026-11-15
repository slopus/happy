import type { SettingsComputerProvider } from "./computer-provider-descriptor.js";

export const computerProviderRegistry: readonly SettingsComputerProvider[] = [
  {
    id: "desktop",
    displayName: "Test desktop",
    capabilities: { perAccount: true },
    fields: [
      { key: "desktopId", label: "Desktop ID", kind: "text", required: true },
      { key: "endUserId", label: "End user ID", kind: "text", required: true },
      { key: "regionId", label: "Region", kind: "text", required: false },
      { key: "accessKeyId", label: "Access key ID", kind: "secret", required: true },
      { key: "accessKeySecret", label: "Access key secret", kind: "secret", required: true },
      {
        key: "mcpUrl",
        label: "Gateway URL",
        kind: "url",
        required: true,
        validation: "public-https",
      },
      {
        key: "mcpToken",
        label: "Gateway token",
        kind: "secret",
        required: true,
        destination: "mcpUrl",
      },
    ],
    verify(values) {
      for (const field of this.fields) {
        if (field.required && !values[field.key]?.trim()) throw new Error("Missing setting");
      }
      // Core tests inject provider creation; this descriptor only validates saved settings.
      return {};
    },
  },
  {
    id: "test-cloud",
    displayName: "Test cloud",
    capabilities: { perAccount: false },
    fields: [{ key: "apiKey", label: "API key", kind: "secret", required: true }],
    verify(values) {
      if (!values.apiKey) throw new Error("Missing API key");
      return {};
    },
  },
];
export function computerProviderDescriptor(id: string) {
  const descriptor = computerProviderRegistry.find((entry) => entry.id === id);
  if (!descriptor) throw new Error("Unknown computer provider");
  return descriptor;
}
export function computerProviderDescriptors(perAccount = false) {
  return computerProviderRegistry
    .filter((entry) => !perAccount || entry.capabilities.perAccount)
    .map(({ id, displayName, capabilities, fields }) => ({
      id,
      displayName,
      capabilities,
      fields,
    }));
}
