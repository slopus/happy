import { SandboxRateLimitError, SandboxUnresponsiveError } from "@rakazo/adapter-kit";
import { sandboxNotFoundError } from "./sandbox-errors.js";

/** Desktop states the ECD API reports; anything else is treated as in transition. */
export type WuyingDesktopStatus = string;

export interface WuyingOpenApiConfig {
  accessKeyId: string;
  accessKeySecret: string;
  regionId: string;
}

/** The control-plane calls a Wuying computer needs: its state, power and screen login. */
export interface WuyingControlPlane {
  desktopStatus(desktopId: string, signal: AbortSignal): Promise<WuyingDesktopStatus | null>;
  startDesktop(desktopId: string, signal: AbortSignal): Promise<void>;
  stopDesktop(desktopId: string, signal: AbortSignal): Promise<void>;
  authCode(endUserId: string, signal: AbortSignal): Promise<string>;
}

const REQUEST_TIMEOUT_MS = 15_000;

// Resolves the constructor from SDK builds that publish CommonJS with a default export,
// under both Node and bundler module resolution.
function cjsDefault<T>(module: T): T extends { default: infer C } ? C : T {
  return ((module as { default?: unknown }).default ?? module) as T extends { default: infer C }
    ? C
    : T;
}

// Loaded only when a configured Wuying provider first uses its control plane.
async function loadClients(config: WuyingOpenApiConfig) {
  const [ecd, appstream, openapi, dara] = await Promise.all([
    import("@alicloud/ecd20200930"),
    import("@alicloud/appstream-center20210218"),
    import("@alicloud/openapi-core"),
    import("@darabonba/typescript"),
  ]);
  const EcdClient = cjsDefault(ecd.default);
  const AppstreamClient = cjsDefault(appstream.default);
  const desktop = new EcdClient(
    new openapi.$OpenApiUtil.Config({
      ...config,
      endpoint: `ecd.${config.regionId}.aliyuncs.com`,
    }),
  );
  const login = new AppstreamClient(
    new openapi.$OpenApiUtil.Config({
      ...config,
      endpoint: "appstream-center.aliyuncs.com",
    }),
  );
  const runtime = new dara.RuntimeOptions({
    connectTimeout: REQUEST_TIMEOUT_MS,
    readTimeout: REQUEST_TIMEOUT_MS,
    autoretry: false,
  });
  return { ecd, appstream, desktop, login, runtime };
}

export class WuyingOpenApi implements WuyingControlPlane {
  private clients?: ReturnType<typeof loadClients>;

  constructor(private readonly config: WuyingOpenApiConfig) {}

  async desktopStatus(desktopId: string, signal: AbortSignal) {
    return this.call("DescribeDesktops", signal, async () => {
      const { ecd, desktop, runtime } = await this.load();
      signal.throwIfAborted();
      const response = await desktop.describeDesktopsWithOptions(
        new ecd.DescribeDesktopsRequest({ regionId: this.config.regionId, desktopId: [desktopId] }),
        runtime,
      );
      return (
        response.body?.desktops?.find((entry) => entry.desktopId === desktopId)?.desktopStatus ??
        null
      );
    });
  }

  async startDesktop(desktopId: string, signal: AbortSignal) {
    await this.call("StartDesktops", signal, async () => {
      const { ecd, desktop, runtime } = await this.load();
      signal.throwIfAborted();
      await desktop.startDesktopsWithOptions(
        new ecd.StartDesktopsRequest({ regionId: this.config.regionId, desktopId: [desktopId] }),
        runtime,
      );
    });
  }

  async stopDesktop(desktopId: string, signal: AbortSignal) {
    await this.call("StopDesktops", signal, async () => {
      const { ecd, desktop, runtime } = await this.load();
      signal.throwIfAborted();
      await desktop.stopDesktopsWithOptions(
        new ecd.StopDesktopsRequest({ regionId: this.config.regionId, desktopId: [desktopId] }),
        runtime,
      );
    });
  }

  async authCode(endUserId: string, signal: AbortSignal) {
    const code = await this.call("GetAuthCode", signal, async () => {
      const { appstream, login, runtime } = await this.load();
      signal.throwIfAborted();
      const response = await login.getAuthCodeWithOptions(
        new appstream.GetAuthCodeRequest({ endUserId }),
        runtime,
      );
      return response.body?.authModel?.authCode;
    });
    if (!code) throw new SandboxUnresponsiveError("Wuying returned no screen login code");
    return code;
  }

  private load() {
    this.clients ??= loadClients(this.config);
    const pending = this.clients;
    pending.catch(() => {
      if (this.clients === pending) this.clients = undefined;
    });
    return pending;
  }

  private async call<T>(
    action: string,
    signal: AbortSignal,
    request: () => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    try {
      // The SDK has no AbortSignal API. Bound its network calls and stop awaiting on cancel.
      return await new Promise<T>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        request()
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", abort));
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      // SDK errors may contain signed URLs, credentials and response bodies. Never propagate them.
      const { code, statusCode } = (error ?? {}) as { code?: unknown; statusCode?: unknown };
      if (statusCode === 429 || (typeof code === "string" && code.startsWith("Throttling")))
        throw new SandboxRateLimitError();
      if (typeof code === "string" && /^(InvalidDesktop|DesktopNotFound|NotFound)/.test(code)) {
        throw sandboxNotFoundError(`Wuying ${action}: desktop not found`);
      }
      // A refused AccessKey stays refused, so it is reported as such rather than as a retry.
      if (typeof code === "string" && /^(InvalidAccessKey|SignatureDoesNotMatch)/.test(code))
        throw new Error(`Wuying ${action}: the AccessKey was refused`);
      if (
        statusCode === 403 ||
        (typeof code === "string" && /^(Forbidden|NoPermission)/.test(code))
      )
        throw new Error(`Wuying ${action}: the AccessKey is not allowed this action`);
      throw new SandboxUnresponsiveError(`Wuying ${action} failed`);
    }
  }
}
