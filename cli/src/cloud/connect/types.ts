export type CloudVendorKey = 'openai' | 'anthropic' | 'gemini';

export type ConnectTargetId = 'codex' | 'claude' | 'gemini';

export type CloudConnectResult = Readonly<{
  vendorKey: CloudVendorKey;
  oauth: unknown;
}>;

export type CloudConnectTarget = Readonly<{
  id: ConnectTargetId;
  displayName: string;
  vendorDisplayName: string;
  vendorKey: CloudVendorKey;
  authenticate: () => Promise<unknown>;
  postConnect?: (oauth: unknown) => void;
}>;

