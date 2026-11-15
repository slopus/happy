import type { ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import { SandboxKind } from "@rakazo/contracts";
import { CreateOSSandboxProvider } from "./createos-sandbox.js";
import { assertHostCommandsAllowed, DesktopSandboxProvider } from "./desktop-sandbox.js";
import { DockerSandboxProvider } from "./docker-sandbox.js";
import { E2BSandboxProvider } from "./e2b-sandbox.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { IncusSandboxProvider } from "./incus-sandbox.js";
import type { KubernetesSandboxOptions } from "./kubernetes-sandbox.js";
import { KubernetesSandboxProvider } from "./kubernetes-sandbox.js";
import { NoneSandboxProvider } from "./none-sandbox.js";
import { NovitaSandboxProvider } from "./novita-sandbox.js";
import { RailwaySandboxProvider } from "./railway-sandbox.js";

export interface SandboxProviderOptions {
  hostComputerUrl?: string;
  hostComputerToken?: string;
  supervisorUrl?: string;
  supervisorToken?: string;
  e2bApiKey?: string;
  novitaApiKey?: string;
  sandboxTemplate?: string;
  onUnsafeStop?: (providerRef: string) => Promise<void>;
  /** Whether another running computer still uses the same provider resource. */
  referenceInUse?: (computer: ComputerRef) => Promise<boolean>;
  daytonaApiKey?: string;
  daytonaApiUrl?: string;
  daytonaTarget?: string;
  createosApiKey?: string;
  createosBaseUrl?: string;
  createosShape?: string;
  createosRootfs?: string;
  railwayApiToken?: string;
  railwayEnvironmentId?: string;
  railwayMaxWorkspaceFileBytes?: string;
  railwaySandboxRegion?: string;
  boatApiKey?: string;
  boatApiUrl?: string;
  boxdApiKey?: string;
  boxdOrg?: string;
  instaboxApiKey?: string;
  kubernetesNamespace?: string;
  kubernetesRuntimeClassName?: string;
  kubernetesComputerImage?: string;
  kubernetesCpuLimit?: string;
  kubernetesMemoryLimit?: string;
  kubernetesPodAnnotations?: KubernetesSandboxOptions["podAnnotations"];
  kubernetesPodLabels?: KubernetesSandboxOptions["podLabels"];
  kubernetesReadyTimeoutMs?: number;
  kubernetesHomeClaim?: string;
  kubernetesHomeColocateNamespace?: string;
  kubernetesHomeColocateLabels?: KubernetesSandboxOptions["homeColocateLabels"];
  incusUrl?: string;
  incusClientCert?: string;
  incusClientKey?: string;
  incusServerCert?: string;
  incusProject?: string;
  incusComputerImage?: string;
  incusCpuLimit?: string;
  incusMemoryLimit?: string;
  incusProcessLimit?: string;
  localVmCli?: string;
  localVmComputerImage?: string;
  localVmCpus?: string;
  localVmMemory?: string;
  wuyingAccessKeyId?: string;
  wuyingAccessKeySecret?: string;
  wuyingRegionId?: string;
  wuyingDesktopId?: string;
  wuyingEndUserId?: string;
  wuyingMcpUrl?: string;
  wuyingMcpToken?: string;
  dataDir?: string;
}

function missingRemoteKey(
  provider:
    | "novita"
    | "e2b"
    | "daytona"
    | "createos"
    | "boat"
    | "boxd"
    | "instabox"
    | "railway"
    | "incus"
    | "wuying",
  envName: string,
): SandboxProvider {
  return new NoneSandboxProvider(
    `Computers unavailable: ${envName} is required for SANDBOX_PROVIDER=${provider}.`,
  );
}

export async function createSandboxProvider(
  kind: string,
  opts: SandboxProviderOptions,
): Promise<SandboxProvider> {
  if (kind === "") return new NoneSandboxProvider();
  const parsed = SandboxKind.safeParse(kind);
  if (!parsed.success) {
    throw new Error(
      `Unknown SANDBOX_PROVIDER "${kind}". Use none | docker | e2b | novita | daytona | createos | boat | boxd | instabox | railway | kubernetes | incus | local-vm | wuying | desktop | fake.`,
    );
  }
  const sandboxKind = parsed.data;
  switch (sandboxKind) {
    case "none":
      return new NoneSandboxProvider();
    case "e2b":
      if (!opts.e2bApiKey?.trim()) return missingRemoteKey("e2b", "E2B_API_KEY");
      return new E2BSandboxProvider(opts.e2bApiKey);
    case "novita":
      if (!opts.novitaApiKey?.trim()) return missingRemoteKey("novita", "NOVITA_API_KEY");
      return new NovitaSandboxProvider({
        apiKey: opts.novitaApiKey,
        template: opts.sandboxTemplate,
        onUnsafeStop: opts.onUnsafeStop,
      });
    case "daytona": {
      if (!opts.daytonaApiKey?.trim()) return missingRemoteKey("daytona", "DAYTONA_API_KEY");
      const { createDaytonaSandboxProvider } = await import("./daytona-sandbox.js");
      return createDaytonaSandboxProvider({
        apiKey: opts.daytonaApiKey,
        apiUrl: opts.daytonaApiUrl,
        target: opts.daytonaTarget,
      });
    }
    case "createos":
      if (!opts.createosApiKey?.trim())
        return missingRemoteKey("createos", "CREATEOS_SANDBOX_API_KEY");
      return new CreateOSSandboxProvider({
        apiKey: opts.createosApiKey,
        baseUrl: opts.createosBaseUrl,
        shape: opts.createosShape,
        rootfs: opts.createosRootfs,
      });
    case "boat": {
      if (!opts.boatApiKey?.trim()) return missingRemoteKey("boat", "BOAT_API_KEY");
      const { BoatSandboxProvider } = await import("./boat-sandbox.js");
      return new BoatSandboxProvider({ apiKey: opts.boatApiKey, apiUrl: opts.boatApiUrl });
    }
    case "boxd": {
      if (!opts.boxdApiKey?.trim()) return missingRemoteKey("boxd", "BOXD_API_KEY");
      const { createBoxdSandboxProvider } = await import("./boxd-sandbox.js");
      return createBoxdSandboxProvider({ apiKey: opts.boxdApiKey, org: opts.boxdOrg });
    }
    case "instabox": {
      if (!opts.instaboxApiKey?.trim()) return missingRemoteKey("instabox", "INSTABOX_API_KEY");
      const { InstaboxSandboxProvider } = await import("./instabox-sandbox.js");
      return new InstaboxSandboxProvider({
        apiKey: opts.instaboxApiKey,
        onUnsafeStop: opts.onUnsafeStop,
      });
    }
    case "railway":
      if (!opts.railwayApiToken?.trim()) return missingRemoteKey("railway", "RAILWAY_API_TOKEN");
      if (!opts.railwayEnvironmentId?.trim())
        return missingRemoteKey("railway", "RAILWAY_ENVIRONMENT_ID");
      return new RailwaySandboxProvider({
        token: opts.railwayApiToken,
        environmentId: opts.railwayEnvironmentId,
        maxWorkspaceFileBytes: opts.railwayMaxWorkspaceFileBytes,
        region: opts.railwaySandboxRegion,
      });
    case "kubernetes":
      return new KubernetesSandboxProvider({
        namespace: opts.kubernetesNamespace,
        runtimeClassName: opts.kubernetesRuntimeClassName,
        computerImage: opts.kubernetesComputerImage,
        cpuLimit: opts.kubernetesCpuLimit,
        memoryLimit: opts.kubernetesMemoryLimit,
        podAnnotations: opts.kubernetesPodAnnotations,
        podLabels: opts.kubernetesPodLabels,
        readyTimeoutMs: opts.kubernetesReadyTimeoutMs,
        homeClaim: opts.kubernetesHomeClaim,
        homeColocateNamespace: opts.kubernetesHomeColocateNamespace,
        homeColocateLabels: opts.kubernetesHomeColocateLabels,
      });
    case "incus": {
      const required = {
        INCUS_SANDBOX_URL: opts.incusUrl,
        INCUS_SANDBOX_CLIENT_CERT: opts.incusClientCert,
        INCUS_SANDBOX_CLIENT_KEY: opts.incusClientKey,
      };
      const missing = Object.entries(required).find(([, value]) => !value?.trim());
      if (missing) return missingRemoteKey("incus", missing[0]);
      return new IncusSandboxProvider({
        url: opts.incusUrl ?? "",
        clientCert: opts.incusClientCert ?? "",
        clientKey: opts.incusClientKey ?? "",
        serverCert: opts.incusServerCert,
        project: opts.incusProject,
        computerImage: opts.incusComputerImage,
        cpuLimit: opts.incusCpuLimit,
        memoryLimit: opts.incusMemoryLimit,
        processLimit: opts.incusProcessLimit,
      });
    }
    case "local-vm": {
      const { AppleContainerSandboxProvider } = await import("./apple-container-sandbox.js");
      return new AppleContainerSandboxProvider({
        cli: opts.localVmCli,
        computerImage: opts.localVmComputerImage,
        cpus: opts.localVmCpus,
        memory: opts.localVmMemory,
      });
    }
    case "wuying": {
      const required = {
        WUYING_ACCESS_KEY_ID: opts.wuyingAccessKeyId,
        WUYING_ACCESS_KEY_SECRET: opts.wuyingAccessKeySecret,
        WUYING_DESKTOP_ID: opts.wuyingDesktopId,
        WUYING_END_USER_ID: opts.wuyingEndUserId,
        WUYING_MCP_URL: opts.wuyingMcpUrl,
        WUYING_MCP_TOKEN: opts.wuyingMcpToken,
      };
      const missing = Object.entries(required).find(([, value]) => !value?.trim());
      if (missing) return missingRemoteKey("wuying", missing[0]);
      const { WuyingSandboxProvider } = await import("./wuying-sandbox.js");
      return WuyingSandboxProvider.fromOptions({
        accessKeyId: opts.wuyingAccessKeyId ?? "",
        accessKeySecret: opts.wuyingAccessKeySecret ?? "",
        regionId: opts.wuyingRegionId,
        desktopId: opts.wuyingDesktopId ?? "",
        endUserId: opts.wuyingEndUserId ?? "",
        mcpUrl: opts.wuyingMcpUrl ?? "",
        mcpToken: opts.wuyingMcpToken ?? "",
        referenceInUse: opts.referenceInUse,
      });
    }
    case "docker":
      return new DockerSandboxProvider(
        opts.supervisorUrl ?? "http://127.0.0.1:7091",
        opts.supervisorToken,
      );
    case "desktop":
      assertHostCommandsAllowed();
      return new DesktopSandboxProvider({
        root: opts.dataDir,
      });
    case "fake":
      return new FakeSandboxProvider();
    default: {
      const _exhaustive: never = sandboxKind;
      throw new Error(
        `Unknown SANDBOX_PROVIDER "${_exhaustive}". Use none | docker | e2b | novita | daytona | createos | boat | boxd | instabox | railway | kubernetes | incus | local-vm | wuying | desktop | fake.`,
      );
    }
  }
}
