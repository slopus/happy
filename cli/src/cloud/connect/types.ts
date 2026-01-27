export type CloudVendorKey = 'openai' | 'anthropic' | 'gemini';

export type ConnectTargetId = 'codex' | 'claude' | 'gemini';

export type CloudConnectTargetStatus = 'wired' | 'experimental';

export type CloudConnectResult = Readonly<{
  vendorKey: CloudVendorKey;
  oauth: unknown;
}>;

export type CloudConnectTarget = Readonly<{
  id: ConnectTargetId;
  displayName: string;
  vendorDisplayName: string;
  vendorKey: CloudVendorKey;
  /**
   * Whether this connect target is actively consumed by Happy (CLI/app) today.
   *
   * - wired: connecting has an effect (token is fetched/used by the product)
   * - experimental: token may be stored but not yet used everywhere
   */
  status: CloudConnectTargetStatus;
  authenticate: () => Promise<unknown>;
  postConnect?: (oauth: unknown) => void;
}>;
