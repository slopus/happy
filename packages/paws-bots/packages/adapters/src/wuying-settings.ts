import { defineComputerProvider } from "./computer-provider-descriptor.js";

const descriptor = defineComputerProvider(
  {
    id: "wuying",
    displayName: "Wuying",
    capabilities: { perAccount: true },
    fields: [
      { key: "desktopId", label: "Desktop ID", kind: "text", required: true },
      { key: "endUserId", label: "End user ID", kind: "text", required: true },
      { key: "regionId", label: "Region", kind: "text", required: false },
      { key: "accessKeyId", label: "AccessKey ID", kind: "secret", required: true },
      { key: "accessKeySecret", label: "AccessKey secret", kind: "secret", required: true },
      {
        key: "mcpUrl",
        label: "MCP gateway URL",
        kind: "url",
        required: true,
        validation: "public-https",
      },
      {
        key: "mcpToken",
        label: "MCP token",
        kind: "secret",
        required: true,
        destination: "mcpUrl",
      },
    ],
  },
  {
    desktopId: "WUYING_DESKTOP_ID",
    endUserId: "WUYING_END_USER_ID",
    regionId: "WUYING_REGION_ID",
    accessKeyId: "WUYING_ACCESS_KEY_ID",
    accessKeySecret: "WUYING_ACCESS_KEY_SECRET",
    mcpUrl: "WUYING_MCP_URL",
    mcpToken: "WUYING_MCP_TOKEN",
  },
);

export const wuyingComputerSettings = {
  ...descriptor,
  verify(values: Record<string, string>) {
    if (values.regionId && !/^[a-z]+(-[a-z0-9]+)+$/.test(values.regionId))
      throw new Error("Invalid region");
    return descriptor.verify(values);
  },
  async verifyConnection(values: Record<string, string>, signal: AbortSignal) {
    const [{ WuyingOpenApi }, { WuyingMcpTools }] = await Promise.all([
      import("./wuying-openapi.js"),
      import("./wuying-sandbox.js"),
    ]);
    const settings = {
      accessKeyId: values.accessKeyId!,
      accessKeySecret: values.accessKeySecret!,
      regionId: values.regionId || "cn-hangzhou",
      desktopId: values.desktopId!,
      endUserId: values.endUserId!,
      mcpUrl: values.mcpUrl!,
      mcpToken: values.mcpToken!,
    };
    const control = new WuyingOpenApi(settings);
    const status = await control.desktopStatus(settings.desktopId, signal);
    if (status === null) throw new Error("Desktop unavailable");
    await control.authCode(settings.endUserId, signal);
    if (status === "Running")
      await new WuyingMcpTools({ url: settings.mcpUrl, token: settings.mcpToken }).call(
        "env_get",
        { name: "USERPROFILE" },
        signal,
      );
  },
};
